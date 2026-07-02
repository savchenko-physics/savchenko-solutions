// utils.js
const fs = require("fs");
const path = require("path");
const { marked } = require("marked");
const sanitizeHtml = require("sanitize-html");

/** Matches problem files like 1.1.10 (used to block path traversal in :name params). */
const SOLUTION_PROBLEM_NAME_RE = /^\d+\.\d+\.\d+$/;

function isValidSolutionLang(lang) {
    return lang === "en" || lang === "ru";
}

function isValidSolutionProblemName(name) {
    return typeof name === "string" && SOLUTION_PROBLEM_NAME_RE.test(name);
}

/** Strips fenced and inline code so we do not flag safe examples like `<script>` in backticks. */
function markdownForDangerScan(content) {
    let s = content;
    s = s.replace(/```[\s\S]*?```/g, "");
    s = s.replace(/`[^`\n]+`/g, "");
    return s;
}

/**
 * Rejects markdown that could become XSS or other harmful HTML when rendered.
 * Iframes are allowed (any http(s) src passes through sanitize-html).
 */
function validateSolutionMarkdownContent(content, lang = "en") {
    if (typeof content !== "string") {
        return {
            ok: false,
            message:
                lang === "ru"
                    ? "Некорректное содержимое."
                    : "Invalid content.",
        };
    }

    const scan = markdownForDangerScan(content);

    const checks = [
        { test: /<\s*script\b/i, key: "script" },
        { test: /<\s*\/\s*script\s*>/i, key: "script" },
        { test: /<\s*object\b/i, key: "object" },
        { test: /<\s*embed\b/i, key: "embed" },
        { test: /<\s*link\b/i, key: "link" },
        { test: /<\s*meta\b/i, key: "meta" },
        { test: /<\s*base\b/i, key: "base" },
        { test: /<\s*style\b/i, key: "style" },
        { test: /javascript\s*:/i, key: "url" },
        { test: /vbscript\s*:/i, key: "url" },
        { test: /data\s*:\s*text\s*\/\s*html/i, key: "data" },
        { test: /\bon\w+\s*=/i, key: "handler" },
    ];

    for (const { test, key } of checks) {
        if (test.test(scan)) {
            const messages = {
                script: {
                    en: "Script tags and embedded scripts are not allowed in solutions.",
                    ru: "Теги script и встроенные сценарии в решениях запрещены.",
                },
                object: {
                    en: "Object embed tags are not allowed.",
                    ru: "Тег object для встраивания запрещён.",
                },
                embed: {
                    en: "Embed tags are not allowed.",
                    ru: "Тег embed запрещён.",
                },
                link: {
                    en: "Link tags are not allowed.",
                    ru: "Тег link запрещён.",
                },
                meta: {
                    en: "Meta tags are not allowed.",
                    ru: "Тег meta запрещён.",
                },
                base: {
                    en: "Base tags are not allowed.",
                    ru: "Тег base запрещён.",
                },
                style: {
                    en: "Style tags are not allowed.",
                    ru: "Тег style запрещён.",
                },
                url: {
                    en: "javascript: / vbscript: URLs are not allowed.",
                    ru: "Адреса javascript: и vbscript: запрещены.",
                },
                data: {
                    en: "data:text/html payloads are not allowed.",
                    ru: "Вложения data:text/html запрещены.",
                },
                handler: {
                    en: "Inline event handlers (onclick, onerror, …) are not allowed.",
                    ru: "Встроенные обработчики событий (onclick, onerror и т.д.) запрещены.",
                },
            };
            const m = messages[key];
            return { ok: false, message: lang === "ru" ? m.ru : m.en };
        }
    }

    return { ok: true };
}

const SANITIZE_MARKDOWN_HTML_OPTIONS = {
    allowedTags: Array.from(
        new Set([
            ...sanitizeHtml.defaults.allowedTags,
            // marked + our posts use images; sanitize-html 2.x defaults omit img
            "img",
            "iframe",
            "figure",
            "figcaption",
            "center",
            "video",
            "source",
        ])
    ),
    allowedAttributes: {
        ...sanitizeHtml.defaults.allowedAttributes,
        a: ["href", "name", "target", "rel", "title", "id"],
        img: ["src", "alt", "width", "height", "loading", "style", "class", "id"],
        iframe: [
            "src",
            "width",
            "height",
            "frameborder",
            "allowfullscreen",
            "class",
            "title",
            "allow",
            "sandbox",
            "referrerpolicy",
            "loading",
            "name",
            "id",
        ],
        div: ["class", "style", "id"],
        span: ["class", "style", "id"],
        center: ["style", "class", "id"],
        figure: ["class", "style", "id"],
        figcaption: ["class", "style"],
        table: ["class", "style"],
        td: ["colspan", "rowspan", "align", "style"],
        th: ["colspan", "rowspan", "align", "style"],
        code: ["class"],
        pre: ["class"],
        p: ["class", "id"],
        h1: ["id", "class"],
        h2: ["id", "class"],
        h3: ["id", "class"],
        h4: ["id", "class"],
        h5: ["id", "class"],
        h6: ["id", "class"],
        ol: ["start", "type", "class"],
        ul: ["type", "class"],
        li: ["class"],
        blockquote: ["class"],
    },
};

function sanitizeParsedMarkdownHtml(html) {
    return sanitizeHtml(html, SANITIZE_MARKDOWN_HTML_OPTIONS);
}

function escapeLatex(input) {
    return input
        .replace(/_/g, "\\_") // Escape underscores
        .replace(/\*/g, "\\*") // Escape asterisks
        .replace(/~/g, "\\~"); // Escape tildes if needed
}

// Custom renderer to handle inline LaTeX blocks
const renderer = new marked.Renderer();

renderer.codespan = function (token) {
    const code = typeof token === 'string' ? token : token.text;
    if (code.startsWith("latex:")) {
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
const parseMarkdown = (markdownText) => {
    let content = escapeMarkdown(markdownText);
    content = content.replace(/\\\[/g, '\\\\[').replace(/\\\]/g, '\\\\]');
    content = content.replace(/\\\(/g, '\\\\(').replace(/\\\)/g, '\\\\)');
    return sanitizeParsedMarkdownHtml(marked(content));
};

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

        "\\^1": "¹",
        "\\^2": "²",
        "\\^3": "³",
        "\\^4": "⁴",
        "\\^5": "⁵",
        "\\^6": "⁶",
        "\\^7": "⁷",
        "\\^8": "⁸",
        "\\^9": "⁹",
        "\\^0": "⁰",

        "_1": "₁",
        "_2": "₂",
        "_3": "₃",
        "_4": "₄",
        "_5": "₅",
        "_6": "₆",
        "_7": "₇",
        "_8": "₈",
        "_9": "₉",
        "_0": "₀",

        // Greek letters (lowercase)
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
        // Greek letters (uppercase)
        "\\\\Gamma": "Γ",
        "\\\\Delta": "Δ",
        "\\\\Theta": "Θ",
        "\\\\Lambda": "Λ",
        "\\\\Xi": "Ξ",
        "\\\\Pi": "Π",
        "\\\\Sigma": "Σ",
        "\\\\Upsilon": "Υ",
        "\\\\Phi": "Φ",
        "\\\\varphi": "φ",
        "\\\\Psi": "Ψ",
        "\\\\Omega": "Ω",
        // Math operators and symbols
        "\\\\times": "×",
        "\\\\div": "÷",
        "\\\\pm": "±",

        "\\\\mp": "∓",
        "\\\\cdot": "·",
        "\\\\leq": "≤",
        "\\\\geq": "≥",
        "\\\\neq": "≠",
        "\\\\approx": "≈",
        "\\\\equiv": "≡",
        "\\\\infty": "∞",
        "\\\\partial": "∂",
        "\\\\nabla": "∇",
        "\\\\sum": "∑",
        "\\\\prod": "∏",
        "\\\\int": "∫",
        "\\\\sqrt": "√",
        // Arrows
        "\\\\rightarrow": "→",
        "\\\\leftarrow": "←",
        "\\\\Rightarrow": "⇒",
        "\\\\Leftarrow": "⇐",
        // Formatting and spacing
        "\\,": " ",
        "\\\\": "",
        "\\{": "{",
        "\\}": "}",
        "\\[": "[",
        "\\]": "]",
        "\\(": "(",
        "\\)": ")",
        // Common math functions
        "\\\\sin": "sin",
        "\\\\cos": "cos",
        "\\\\tan": "tan",
        "\\\\log": "log",
        "\\\\ln": "ln",
        "\\\\exp": "exp",
        // Subscripts and superscripts
        "_": "",
        "\\^": "",
        // Additional math operators and symbols
        "\\\\forall": "∀",
        "\\\\exists": "∃",
        "\\\\nexists": "∄",
        "\\\\in": "∈",
        "\\\\notin": "∉",
        "\\\\subset": "⊂",
        "\\\\supset": "⊃",
        "\\\\subseteq": "⊆",
        "\\\\supseteq": "⊇",
        "\\\\cup": "∪",
        "\\\\cap": "∩",
        "\\\\emptyset": "∅",
        "\\\\therefore": "∴",
        "\\\\because": "∵",
        "\\\\sim": "∼",
        "\\\\perp": "⊥",
        "\\\\parallel": "∥",
        "\\\\angle": "∠",
        "\\\\triangle": "△",
        "\\\\square": "□",
        "\\\\cong": "≅",
        "\\\\neg": "¬",
        "\\\\wedge": "∧",
        "\\\\vee": "∨",
        "\\\\oplus": "⊕",
        "\\\\otimes": "⊗",
        "\\\\bullet": "•",
        "\\\\circ": "∘",
        "\\\\propto": "∝",
        "\\\\prime": "′",
        "\\\\aleph": "ℵ",
        "\\\\wp": "℘",
        "\\\\Re": "ℜ",
        "\\\\Im": "ℑ",
        "\\\\top": "⊤",
        "\\\\bot": "⊥",
        "\\\\vdash": "⊢",
        "\\\\models": "⊨",
        "\\\\langle": "⟨",
        "\\\\rangle": "⟩",
        "\\\\lceil": "⌈",
        "\\\\rceil": "⌉",
        "\\\\lfloor": "⌊",
        "\\\\rfloor": "⌋",
        "\\\\nabla": "∇",
        "\\\\partial": "∂",
        "\\\\ell": "ℓ",
        "\\\\eth": "ð",
        "\\\\hbar": "ℏ",
        "\\\\clubsuit": "♣",
        "\\\\diamondsuit": "♢",
        "\\\\heartsuit": "♡",
        "\\\\spadesuit": "♠",
        // Additional arrows
        "\\\\leftrightarrow": "↔",
        "\\\\Leftrightarrow": "⇔",
        "\\\\uparrow": "↑",
        "\\\\downarrow": "↓",
        "\\\\updownarrow": "↕",
        "\\\\mapsto": "↦",
        "\\\\rightharpoonup": "⇀",
        "\\\\rightharpoondown": "⇁",
        "\\\\leftharpoonup": "↼",
        "\\\\leftharpoondown": "↽",
        // Additional spacing commands
        "\\;": " ",
        "\\:": " ",
        "\\!": "",
        "\\quad": "    ",
        "\\qquad": "        ",
        "\\text{": "",
        "\\mathrm{": "",
        "fbox{": "",
        "\\begin": "",
        "\\end": "",
        "\\begin": "",
        "\\end": "",
        "\\left": "",
        "\\right": ""
    };



    // Remove dollar signs surrounding LaTeX expressions
    let plainText = latexLine.replace(/\$/g, "");

    // Replace LaTeX symbols with plain text equivalents
    for (const [latex, plain] of Object.entries(symbolMap)) {
        const regex = new RegExp(latex, "g");
        plainText = plainText.replace(regex, plain);
    }

    // Clean up any remaining LaTeX-specific formatting
    plainText = plainText
        .replace(/\\text\{([^}]+)\}/g, "$1") // Remove \text{} wrapper
        .replace(/\\mathrm\{([^}]+)\}/g, "$1") // Remove \mathrm{} wrapper
        .replace(/\\left|\\right/g, "") // Remove \left and \right commands
        .replace(/\s+/g, " ") // Normalize whitespace
        .trim();

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

        const webpFilename = filename.replace(/\.(jpg|jpeg|png)$/i, '.webp');
        const hasWebpVariant = /\.(jpg|jpeg|png)$/i.test(filename);

        const imgTag = `<img src="../../img/${folder}/${filename}"
          loading="lazy" alt="${altText}"
          width="${scalePercentage}"
          style="width: min(${scalePercentage}, 100vw);" />`;

        const pictureHtml = hasWebpVariant
            ? `<picture>
          <source srcset="../../img/${folder}/${webpFilename}" type="image/webp">
          ${imgTag}
        </picture>`
            : imgTag;

        return `<center style="margin-top: 5px; margin-bottom: 5px;">
      <figure>
        ${pictureHtml}
        <figcaption>${altText}</figcaption>
      </figure>
      </center>`;
    });
};

/**
 * Auto-link #X.X.X patterns to Savchenko solution pages (in rendered HTML).
 * Skips patterns already inside <a> tags or <code> blocks.
 * lang defaults to 'en'.
 */
function autoLinkProblemRefs(html, lang = 'en') {
    // Match #X.X.X where X are digits, not inside existing tags
    return html.replace(
        /(?<![&\w])#(\d{1,2}\.\d{1,2}\.\d{1,3})(?![^<]*<\/a>)/g,
        `<a href="/${lang}/$1" class="problem-ref" style="color:#1a5276;font-weight:500;text-decoration:none;">#$1</a>`
    );
}

/**
 * Auto-link @username mentions to user profile pages (in rendered HTML).
 * Skips patterns already inside <a> tags.
 */
function autoLinkUserMentions(html) {
    return html.replace(
        /(?<![&\w])@([a-zA-Z0-9_]{2,30})(?![^<]*<\/a>)/g,
        '<a href="/user/$1" class="user-mention" style="color:#1a5276;font-weight:500;text-decoration:none;">@$1</a>'
    );
}

function autoLinkUrls(html) {
    return html.replace(
        /(?<![="'>])(?:https?:\/\/)[^\s<>"']+/g,
        (url) => {
            const clean = url.replace(/[.,;:!?)]+$/, '');
            const trailing = url.slice(clean.length);
            return `<a href="${clean}" target="_blank" rel="noopener noreferrer" style="color:#1a5276;text-decoration:underline;">${clean}</a>${trailing}`;
        }
    );
}

function linkifyMessageContent(text, lang = 'en') {
    const escaped = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    let result = autoLinkUrls(escaped);
    result = autoLinkUserMentions(result);
    result = autoLinkProblemRefs(result, lang);
    return result;
}

/**
 * Run `fn` over the given HTML with all $...$ and $$...$$ math content
 * temporarily masked out so transformations don't touch math expressions.
 * Caller-supplied `fn` operates on the masked HTML string and returns a
 * transformed string; this helper restores the math tokens before returning.
 */
function withMathPreserved(html, fn) {
    const tokens = [];
    // Order matters: match $$...$$ first to avoid the single-$ rule eating one half.
    const masked = html
        .replace(/\$\$[\s\S]+?\$\$/g, (m) => {
            const i = tokens.push(m) - 1;
            return ` MATHD${i} `;
        })
        .replace(/\$[^\$\n<>]+\$/g, (m) => {
            const i = tokens.push(m) - 1;
            return ` MATHI${i} `;
        });
    const out = fn(masked);
    return out.replace(/ MATH[DI](\d+) /g, (_, n) => tokens[+n]);
}

/**
 * Auto-link bare problem references (e.g. "14.2.1") in rendered HTML to
 * /<lang>/<ref>. Used by the blog renderer so authors don't need to mark
 * them up. Skips refs already inside <a> tags, attribute values, and math.
 */
function autoLinkBareProblemRefs(html, lang = 'en') {
    return withMathPreserved(html, (h) =>
        h.replace(
            /(?<![\d.\w])(\d{1,2}\.\d{1,2}\.\d{1,3})(?![\d.\w])(?![^<]*<\/a>)/g,
            (_, ref) =>
                `<a href="/${lang}/${ref}" class="problem-ref" style="color:#1a5276;text-decoration:none;">${ref}</a>`
        )
    );
}

/** Whitelisted usernames that should be auto-linked in blog post bodies. */
const BLOG_AUTO_LINK_USERNAMES = ['emixter', 'igor', 'astrosander'];

/**
 * Russian-name → username mappings for blog auto-linking.
 * Each entry maps a Cyrillic name (with optional case suffixes) to a username.
 */
const BLOG_RUSSIAN_NAME_TO_USERNAME = [
    // Игорь / Игоря / Игорю / Игорем / Игоре / Игоревич ... → igor
    { pattern: /(?<![А-Яа-яёЁ])(Игор[а-яё]*)(?![А-Яа-яёЁ])(?![^<]*<\/a>)/g, username: 'igor' },
];

/**
 * Auto-link known usernames and Russian-name mentions in rendered HTML.
 * Whitelist-based so common words aren't accidentally linked.
 * Skips matches already inside <a> tags or math.
 */
function autoLinkBlogUsernames(html) {
    return withMathPreserved(html, (h) => {
        // Latin usernames (case-insensitive, but preserve original text)
        const userRe = new RegExp(
            `(?<![\\w])(${BLOG_AUTO_LINK_USERNAMES.join('|')})(?![\\w])(?![^<]*<\\/a>)`,
            'gi'
        );
        let result = h.replace(userRe, (match) => {
            const lower = match.toLowerCase();
            return `<a href="/user/${lower}" class="user-mention" style="color:#1a5276;text-decoration:none;">${match}</a>`;
        });
        // Russian name aliases
        for (const { pattern, username } of BLOG_RUSSIAN_NAME_TO_USERNAME) {
            result = result.replace(pattern, (match) =>
                `<a href="/user/${username}" class="user-mention" style="color:#1a5276;text-decoration:none;">${match}</a>`
            );
        }
        return result;
    });
}

/**
 * Apply blog-specific link transformations to already-rendered markdown HTML.
 * Order: existing #-prefixed refs → bare refs → usernames.
 */
function linkifyBlogHtml(html, lang = 'en') {
    let out = autoLinkProblemRefs(html, lang);     // existing #X.X.X refs
    out = autoLinkBareProblemRefs(out, lang);       // bare X.X.X refs
    out = autoLinkBlogUsernames(out);
    return out;
}

module.exports = {
    parseMarkdown,
    getMarkdownFiles,
    getLineStatement,
    transformImageMarkdown,
    convertLatexToPlainText,
    validateSolutionMarkdownContent,
    isValidSolutionLang,
    isValidSolutionProblemName,
    sanitizeParsedMarkdownHtml,
    autoLinkProblemRefs,
    autoLinkBareProblemRefs,
    autoLinkUserMentions,
    autoLinkBlogUsernames,
    autoLinkUrls,
    linkifyMessageContent,
    linkifyBlogHtml,
};
