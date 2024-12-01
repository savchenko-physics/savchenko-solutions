// utils.js
const fs = require("fs");
const path = require("path");
const { marked } = require("marked");

function escapeLatex(input) {
    return input
        .replace(/_/g, "\\_") // Escape underscores
        .replace(/\*/g, "\\*") // Escape asterisks
        .replace(/~/g, "\\~"); // Escape tildes if needed
}

// Custom renderer to handle inline LaTeX blocks
const renderer = new marked.Renderer();

renderer.codespan = function (code) {
    if (code.startsWith("latex:")) {
        // Remove "latex:" tag, escape LaTeX-specific characters, and wrap in HTML to avoid Markdown parsing
        return `<code>${escapeLatex(code.slice(6))}</code>`;
    }
    return `<code>${code}</code>`;
};

// Configure marked options
marked.setOptions({
    renderer: renderer,
    breaks: true, // Enable line breaks
    gfm: true, // Enable GitHub Flavored Markdown
    smartLists: true, // Enable improved list parsing
    headerIds: false, // Disable ID generation for headers
    xhtml: false, // Avoid XHTML self-closing tags for faster parsing
});

// Function to escape special markdown characters
const escapeMarkdown = (text) => {
    return text;
};

// Function to parse Markdown content into HTML
const parseMarkdown = (markdownText) => marked(escapeMarkdown(markdownText));

// Function to get all Markdown files from the public directory
const getMarkdownFiles = (directory) => {
    try {
        // Read all files in the specified directory
        const files = fs.readdirSync(directory);

        // Filter and map files to remove the .md extension
        return files.filter((file) => file.endsWith(".md")).map((file) => file.replace(".md", ""));
    } catch (error) {
        console.error("Error reading files:", error);
        return [];
    }
};

function convertLatexToPlainText(latexLine) {
    // Define mappings for LaTeX symbols to plain text
    const symbolMap = {
        "\\\\alpha": "α",
        "\\\\beta": "β",
        "\\\\gamma": "γ",
        "\\\\delta": "δ",
        "\\\\epsilon": "ε",
        "\\\\zeta": "ζ",
        "\\\\eta": "η",
        "\\\\theta": "θ",
        "\\\\iota": "ι",
        "\\\\kappa": "κ",
        "\\\\lambda": "λ",
        "\\\\mu": "μ",
        "\\\\nu": "ν",
        "\\\\xi": "ξ",
        "\\\\omicron": "ο",
        "\\\\pi": "π",
        "\\\\rho": "ρ",
        "\\\\sigma": "σ",
        "\\\\tau": "τ",
        "\\\\upsilon": "υ",
        "\\\\phi": "φ",
        "\\\\chi": "χ",
        "\\\\psi": "ψ",
        "\\\\omega": "ω",
        "\\\\Gamma": "Γ",
        "\\\\Delta": "Δ",
        "\\\\Theta": "Θ",
        "\\\\Lambda": "Λ",
        "\\\\Xi": "Ξ",
        "\\\\Pi": "Π",
        "\\\\Sigma": "Σ",
        "\\\\Upsilon": "Υ",
        "\\\\Phi": "Φ",
        "\\\\Psi": "Ψ",
        "\\\\Omega": "Ω",
        "\\,": "",
        "\\\\": "",
        "\\{": "",
        "\\}": "",
    };

    // Remove dollar signs surrounding LaTeX expressions
    let plainText = latexLine.replace(/\$/g, "");

    // Replace LaTeX symbols with plain text equivalents
    for (const [latex, plain] of Object.entries(symbolMap)) {
        const regex = new RegExp(latex, "g");
        // console.log(regex, plain)
        plainText = plainText.replace(regex, plain);
    }

    return plainText;
}

function getLineStatement(text) {
    text = text.replace("^", "").replace("{", "").replace("}", "").replace("\\*", "").replace("*", "").replace("∗", "").replace("$", "");
    
    const regex = /^\$?\d+\.\d+\.\d+\.\$\s+(.+)/m;

    const match = text.match(regex);

    return match ? convertLatexToPlainText(match[1]) : "Solution";
}

const transformImageMarkdown = (htmlContent) => {
    // Regular expression for YouTube URL format, e.g., ![](https://www.youtube.com/embed/VIDEO_ID)
    const youtubeRegex = /!\[\]\((https:\/\/www\.youtube\.com\/embed\/[a-zA-Z0-9_-]+(\?t=\d+)?)\)/g;

    // Replace YouTube URL format with video container HTML
    htmlContent = htmlContent.replace(youtubeRegex, (match, youtubeUrl) => {
        return `<div class="video-container">
                    <iframe allowfullscreen="" class="video" frameborder="0" src="${youtubeUrl}"></iframe>
                </div>`;
    });

    // Regular expression to match image markdown with dimensions and scale, e.g., ![alt text|widthxheight,scale%](path)
    const regex = /!\[(.*?)?\|(.*?x.*?)?,?(\d+%)?\]\(\.\.\/\.\.\/img\/(.*?)\/(.*?)\)/g;

    return htmlContent.replace(regex, (match, altText = "", dimensions, scale, folder, filename) => {
        // Extract width, height, and scale if provided
        let width = "auto",
            height = "auto";
        let scalePercentage = "100%"; // Default scale

        if (dimensions) {
            const [w, h] = dimensions.split("x");
            width = w ? `${w}px` : "auto";
            height = h ? `${h.replace("\\, ", "")}px` : "auto";
        }
        if (scale) {
            const percentage = parseInt(scale);
            scalePercentage = `${Math.round(600 * (percentage/100))}px`;

            console.log(scalePercentage);
        }

        return `<center>
      <figure>
        <img src="..\\..\\img\\${folder}\\${filename}"
          loading="lazy" alt="${altText}" width="${scalePercentage}" style="max-width:${width}; max-height:${height};" />
        <figcaption>${altText}</figcaption>
      </figure>
      </center>`;
    });
};

module.exports = {
    parseMarkdown,
    getMarkdownFiles,
    getLineStatement,
    transformImageMarkdown,
    convertLatexToPlainText
};
