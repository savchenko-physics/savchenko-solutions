import os
import csv
import re
import pg8000.native as pg
from dateutil import parser
import time

def extract_problem_name(input_string):
    """
    Extract language and problem_name from path-like string, e.g. "commit_history\\en\\foobar"
    """
    first_match = re.search(r'\\([^\\]+)', input_string)
    first_data = first_match.group(1) if first_match else None

    last_match = re.search(r'\\([^\\]+)$', input_string)
    last_data = last_match.group(1) if last_match else None

    return first_data, last_data


def list_folders(path):
    """
    Return subfolder paths where the folder name
    contains exactly two dots.
    """
    folder_list = []
    for root, dirs, files in os.walk(path):
        for dir_name in dirs:
            # E.g. a folder name like "en.problemName" if that pattern matches the usage
            if dir_name.count('.') == 2:
                folder_list.append(os.path.join(root, dir_name))
    return folder_list


def load_html(html_path):
    """
    Read an HTML file from html_path and return its text content.
    """
    with open(html_path, 'r', encoding='utf-8') as file:
        html_content = file.read()
    return html_content


default_folder = "commit_history"
csv_name = "commit_log.csv"
problem_folders = list_folders(default_folder)

# Batching logic
BATCH_SIZE = 100

def insert_batch(connection, data_batch):
    """
    Insert a batch of rows in a single transaction to minimize overhead.
    Expects data_batch to be a list of dicts, each matching the placeholder fields in insert_query.
    """
    if not data_batch:
        return  # nothing to do

    insert_query = """
    INSERT INTO "github_contributions" 
        (language, problem_name, original_content, new_content, edited_at, commit, user_id, caption)
    VALUES 
        (:language, :problem_name, :original_content, :new_content, :edited_at, :commit, :user_id, :caption)
    """

    # Perform the insert in a single transaction
    try:
        connection.run("BEGIN")
        for row_data in data_batch:
            connection.run(insert_query, **row_data)
        connection.run("COMMIT")
        print(f"{len(data_batch)} rows inserted successfully.")
    except Exception as e:
        connection.run("ROLLBACK")
        print(f"Error inserting batch: {e}")


def build_commit_data(lang, problem, present_html, previous_html, time_moment, commit, user_id, caption):
    """
    Convert row input into a dictionary that matches the columns of the DB insert.
    """
    # Convert time_moment string to datetime
    try:
        edited_at = parser.parse(time_moment)
    except ValueError as e:
        print(f"Skipping row due to date parsing error: {e}")
        return None

    return {
        'language': lang,
        'problem_name': problem,
        'original_content': previous_html,
        'new_content': present_html,
        'edited_at': edited_at,
        'commit': commit,
        'user_id': user_id,
        'caption': caption
    }


def main():
    # ----------------------------------------------------------------------
    # Initialize one DB connection (reuse for entire script)
    # ----------------------------------------------------------------------
    host = "imagesharing.c1ig8myqybl5.us-east-2.rds.amazonaws.com"
    port = 5432
    database = "savchenko"
    user = "postgres"
    password = "Astrosander12!"
    conn = None

    try:
        conn = pg.Connection(user=user, password=password, host=host, port=port, database=database)
    except Exception as e:
        print(f"Could not connect to database: {e}")
        return

    # We'll accumulate row dictionaries in data_batch
    data_batch = []

    # Process each problem folder
    for problem_name in problem_folders:
        # print(problem_name)
    
        print(f"Processing folder: {problem_name}")
        csv_full_path = os.path.join(problem_name, csv_name)

        rows = []
        # Read the CSV that tracks commit info
        with open(csv_full_path, mode='r', encoding='utf-8') as file:
            csv_reader = csv.reader(file)
            for row in csv_reader:
                rows.append(row)

        # Rows structure: row[0] = commit, row[1] = time_moment, row[2] = user_name, row[3] = caption
        # We'll pass (currentRow, nextRow) to reconstruct present/previous HTML
        for row_id in range(1, len(rows)):
            current_row = rows[row_id]
            # next row is the "older" commit for comparing HTML
            # in the original code did row_present, row_old
            # but we can rename for clarity
            if (row_id + 1) < len(rows):
                previous_row = rows[row_id + 1]
            else:
                previous_row = None

            # Because the original code processes "row_present" and the "next row" as the old commit
            # let's adjust carefully:
            # Actually we want `procced_commit(problem_name, rows[row_id], rows[row_id + 1])`
            # so let's mimic that logic exactly

            # If row_id+1 is in range
            if row_id + 1 < len(rows):
                row_present = rows[row_id]
                row_old = rows[row_id + 1]
            else:
                # final row
                row_present = rows[row_id]
                row_old = None

            # Parse out fields from row_present
            try:
                commit, time_moment, user_name, caption = row_present
            except ValueError:
                # If the row isn't well-formed, skip it
                continue

            # Load present HTML
            try:
                present_html = load_html(os.path.join(problem_name, commit) + ".html")
            except Exception as e:
                print(f"Skipping commit {commit}: cannot load present HTML. Error={e}")
                continue

            # Load previous HTML if available
            if row_old is not None:
                commit_old, _, _, _ = row_old
                try:
                    previous_html = load_html(os.path.join(problem_name, commit_old) + ".html")
                except Exception:
                    previous_html = ""
            else:
                previous_html = ""  # if it's the first commit

            # Determine language, problem
            lang, problem = extract_problem_name(problem_name)

            if lang != "en":
                lang = "ru"

            # Map user_id
            if user_name in ["LuisDFQ", "Luisito"]:
                user_id = '34'
            elif user_name == "Technoglark":
                user_id = '68'
            else:
                user_id = '28'
                # This debug print was in the code
                if user_name not in ["Aliaksandr Melnichenka", "LuisDFQ", "Luisito", "Technoglark"]:
                    print(f"Unknown user mapped to user_id=28 -> {user_name}")

            # Build data dict for DB
            row_data = build_commit_data(
                lang, problem, present_html, previous_html,
                time_moment, commit, user_id, caption
            )
            if row_data:
                data_batch.append(row_data)

            # If we hit the batch size, insert into DB
            if len(data_batch) >= BATCH_SIZE:
                insert_batch(conn, data_batch)
                data_batch = []

        # After the loop for each folder, do a final insert of any leftover
        if data_batch:
            insert_batch(conn, data_batch)
            data_batch = []

    # After processing all folders, close the DB connection
    if conn is not None:
        conn.close()
        print("Database connection closed.")


if __name__ == "__main__":
    main()
