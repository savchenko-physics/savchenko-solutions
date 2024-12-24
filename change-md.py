import os
import re

# Directories containing the markdown files
directories = ['posts/en/', 'posts/ru/']

# Iterate over all directories
for directory in directories:
    # Iterate over all files in the current directory
    for filename in os.listdir(directory):
        if filename.endswith('.md'):
            filepath = os.path.join(directory, filename)
            
            # Read the file
            with open(filepath, 'r', encoding='utf-8') as file:
                content = file.readlines()
            
            # Remove spaces at the beginning and end of each line
            content = [line.strip() for line in content]
            content = "\n".join(content)

            # content = re.sub(r'(!\[.*?\]\(.*?\))\s+.*', r'\1', content)
            
            updated_content = re.sub(r'\n{3,}', '\n\n', content)

            # Add newlines before and after inline math $$ $$ using regex
            updated_content = re.sub(r'\$\$(.*?)\$\$', r'\n\n$$\n\1\n$$\n\n', updated_content)

            for i in range(10, 1, -1):
                for j in range(10, 1, -1):
                    i_num = "\n" * i
                    j_num = "\n" * j

                    if i != 2 and j != 2:
                        updated_content = re.sub(i_num + r'\$\$\n(.*?)\n\$\$' + j_num, r'\n\n$$\n\1\n$$\n\n', updated_content)

            if updated_content.endswith("###"):
                updated_content = updated_content[:-3]

            updated_content = updated_content.rstrip('\n')

            with open(filepath, 'w', encoding='utf-8') as file:
                file.write(updated_content)

print("Replacement complete.")