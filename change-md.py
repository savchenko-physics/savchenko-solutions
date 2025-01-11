import os
import re

# Directories containing the markdown files
directories = ['posts/en/', 'posts/ru/']

def process_file(filepath):
    # Read the file
    with open(filepath, 'r', encoding='utf-8') as file:
        content = file.readlines()
    
    # Remove spaces at the beginning and end of each line
    content = [line.strip() for line in content]
    content = "\n".join(content)
    
    updated_content = re.sub(r'\n{2,}', '\n\n', content)

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

    # Remove repeated text after image links, including any text that follows the image link
    updated_content = re.sub(r'(!\[.*?\s*\|\s*.*?\]\(.*?\))([^\n]*)', r'\1', updated_content)

    # Replace \quad (1), \; (1), \, (1), (*) with \tag{1}
    updated_content = re.sub(r'\\(?:quad|;|,)\s*\((\d+)\)', r'\\tag{\1}', updated_content)

    # Replace Greek letters with LaTeX equivalents
    greek_replacements = {
        'α': r'\alpha ',
        'β': r'\beta ',
        'γ': r'\gamma ',
        'δ': r'\delta ',
        'ε': r'\varepsilon ',
        'ζ': r'\zeta ',
        'η': r'\eta ',
        'θ': r'\theta ',
        'ι': r'\iota ',
        'κ': r'\kappa ',
        'λ': r'\lambda ',
        'μ': r'\mu ',
        'ν': r'\nu ',
        'ξ': r'\xi ',
        'ο': r'o ',  # Note: 'ο' is typically not used in LaTeX as a standalone symbol
        'π': r'\pi ',
        'ρ': r'\rho ',
        'σ': r'\sigma ',
        'τ': r'\tau ',
        'υ': r'\upsilon ',
        'φ': r'\phi ',
        'χ': r'\chi ',
        'ψ': r'\psi ',
        'ω': r'\omega ',
        'Α': r'A ',  # Note: Uppercase Greek letters are often the same as Latin
        'Β': r'B ',
        'Γ': r'\Gamma ',
        'Δ': r'\Delta ',
        'Ε': r'E ',
        'Ζ': r'Z ',
        'Η': r'H ',
        'Θ': r'\Theta ',
        'Ι': r'I ',
        'Κ': r'K ',
        'Λ': r'\Lambda ',
        'Μ': r'M ',
        'Ν': r'N ',
        'Ξ': r'\Xi ',
        'Ο': r'O ',
        'Π': r'\Pi ',
        'Ρ': r'P ',
        'Σ': r'\Sigma ',
        'Τ': r'T ',
        'Υ': r'Y ',
        'Φ': r'\Phi ',
        'Χ': r'X ',
        'Ψ': r'\Psi ',
        'Ω': r'\Omega ',
        '◦': r'^{\circ} ',
    }
    
    for greek_letter, latex_equivalent in greek_replacements.items():
        updated_content = updated_content.replace(greek_letter, latex_equivalent)

    with open(filepath, 'w', encoding='utf-8') as file:
        file.write(updated_content)

# Iterate over all directories
for directory in directories:
    # Iterate over all files in the current directory
    for filename in os.listdir(directory):
        if filename.endswith('.md'):
            filepath = os.path.join(directory, filename)
            
            # Process the file twice
            process_file(filepath)
            process_file(filepath)

print("Replacement complete.")