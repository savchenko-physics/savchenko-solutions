import html2text
import os, re
from bs4 import BeautifulSoup
from PIL import Image

def get_image_size(file_path):
    # print(file_path)
    with Image.open(file_path) as img:
        width, height = img.size
    return f"{width}x{height}"

def get_percentages(file_path, current_width):
    with Image.open(file_path) as img:
        width, height = img.size

    # print(current_width)

    return int(int(current_width)/600*100+1)


def remove_line_breaks_in_p_tags(file_path):   
    with open(file_path, 'r', encoding='utf-8') as file:
        html_content = file.read()

    # if "video-container" in html_content and "youtube.com" not in html_content:
    #     print(file_path)

    soup = BeautifulSoup(html_content, 'html.parser') 
    problem_number = file_path.split(os.sep)[1]

    # for video_container in soup.find_all('div', class_='video-container'):
    #     video_container.replace_with(f"`{str(video_container)}`")  # Temporarily replace with code block to keep unchanged

    # Process and replace YouTube embeds
    for video_container in soup.find_all('div', class_='video-container'):
        iframe = video_container.find('iframe')
        if iframe:
            video_src = iframe['src']
            custom_md = f'![]({video_src})'
            video_container.replace_with(custom_md)  # Replace with Markdown format


    for tag in ['head', 'header', 'footer']:
        tag_content = soup.find(tag)
        if tag_content:
            tag_content.clear()  # Clear content within the tag

    # Ignore or remove all <hr> tags
    for hr in soup.find_all('hr'):
        hr.decompose()

    # Remove specific <p> tags with author names
    for p in soup.find_all('p', style="text-align: right; font-style: italic; font-size: 14;"):
        p.decompose()  # Remove the tag completely

    for p in soup.find_all('p', style="text-align: right; font-style: italic; font-size: 16;"):
        p.decompose()  # Remove the tag completely

    # Remove specific <h3> tags with id="back-link"
    for h3 in soup.find_all('h3', id="back-link"):
        h3.decompose()  # Remove the tag completely

    for h2 in soup.find_all('h2'):
        a_tag = h2.find('a', href=True)
        if a_tag and 'Назад' in a_tag.text:
            h2.decompose()  

    def image_render(tag, caption_tag):
        # Determine if the tag is a figure or an image
        img_tag = tag if tag.name == 'img' else tag.find('img')
        figure = tag if tag.name == 'figure' else None

        if img_tag:
            img_src = img_tag['src'].split('/')[-1]
            caption = caption_tag.text if caption_tag else ''

            # Set a default caption if none is provided
            # if caption == "":
            #     caption = f"For problem ${problem_number}$"
            
            img_path = rf"../img/{problem_number}/{img_src}".replace('../', '')

            if ".svg" in img_src:
                img_sizes = "1000x1000"
            else:
                img_sizes = get_image_size(img_path)
            
            width = img_tag.get('width', '400').replace('px', '')  # Default width
            if "%" in width:
                img_percentages = width
            elif ".svg" in img_src:
                img_percentages = "400"
            else:
                img_percentages = f"{get_percentages(img_path, width)}%"

            custom_md = f'![{caption}|{img_sizes}, {img_percentages}]({img_path})'
            
            # Replace the <figure> or <img> tag with custom Markdown
            if None:
                figure.replace_with(custom_md)
            else:
                img_tag.replace_with(custom_md)



    for figure in soup.find_all('figure'):
        img_tag = figure.find('img')
        caption_tag = figure.find('figcaption')
        image_render(figure, caption_tag)


    for img_tag in soup.find_all('img'):
        image_render(img_tag, '')


    paragraphs = soup.find_all('p')

    # Iterate through each <p> tag and remove line breaks
    for p in paragraphs:
        for br in p.find_all('br'):
            br.decompose()

    # Return the modified HTML as a string
    return str(soup).replace('\\(','$').replace('\\)','$')

def print_all_file_paths(folder_path):
    for root, dirs, files in os.walk(folder_path):
        for file in files:
            file_path = os.path.join(root, file)
            # print(file_path)


def process_file(file_path, lang):
    html_content = remove_line_breaks_in_p_tags(file_path)


    # Convert HTML to Markdown
    markdown_converter = html2text.HTML2Text()
    markdown_converter.ignore_links = False  # Include links in the Markdown output
    markdown_converter.body_width = 0
    markdown_content = markdown_converter.handle(html_content)
    markdown_converter.ignore_emphasis = True

    markdown_content = re.sub(
        r"`<div class=\"video-container\">(.*?)</div>`",
        r'<div class="video-container">\1</div>',
        markdown_content,
        flags=re.DOTALL
    )


    # Make sure images from the img/ folder
    folder_path = os.path.basename(os.path.dirname(file_path))
    # markdown_content = re.sub(r'!\[(.*?)\]\((.*?)\)', rf'![\1](../img/{folder_path}/\2)', markdown_content)

    markdown_content = re.sub(
        r'!\[(.*?)\]\((.*?)\)',
        lambda match: f'![{match.group(1)}](../../img/{folder_path}/{os.path.basename(match.group(2))})' 
                     if "youtube.com" not in match.group(2) else match.group(0),
        markdown_content
    )


    # Save to Markdown file
    with open(f'posts/{lang}/{folder_path}.md', 'w', encoding='utf-8') as md_file:
        md_file.write(markdown_content)

    # print("Conversion complete. Markdown saved as 'index.md'.")


def process_folder(folder_path, lang):
    for root, dirs, files in os.walk(folder_path):
        for file in files:
            file_path = os.path.join(root, file)
            if 'index.html' not in file_path or file_path.count('.') != 3:
                continue

            process_file(file_path, lang)
            # print(file_path)

folder_path = 'en'

for i in range(1, 15, 1):
    process_folder(str(i), 'ru')

process_folder('en1', 'en')

# file_path = r'en\2.1.26\index.html'  # Replace with the path to your HTML file

# process_file(file_path)