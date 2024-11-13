const express = require('express');
const path = require('path');
const ejs = require('ejs');
const fs = require('fs'); // Import fs module
const {
    parseMarkdown,
    getMarkdownFiles,
    getLineStatement
} = require('./utils'); // Importing functions from utils.js
const {
    eng_page
} = require('./parents_en'); // generating content for the main english page

const {
    ru_page
} = require('./parents_ru'); // generating content for the main russian page


const app = express();
const PORT = 3000;


const transformImageMarkdown = (htmlContent) => {
    // Regular expression for YouTube URL format, e.g., ![](https://www.youtube.com/embed/VIDEO_ID)
    const youtubeRegex = /!\[\]\((https:\/\/www\.youtube\.com\/embed\/[a-zA-Z0-9_-]+)\)/g;
    
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
            height = h ? `${h.replace('\\, ','')}px` : "auto";
        }
        if (scale) {
            scalePercentage = scale;
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


//.replace(/\n/g, '').replace(/\$/g, '').replace('\\', '')


app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'posts')));
app.use('/img', express.static(path.join(__dirname, 'img'))); // Serve images from img folder
app.use('/css', express.static(path.join(__dirname, 'css')));
app.use('/en', express.static(path.join(__dirname, 'en')));
app.use('/theory', express.static(path.join(__dirname, 'theory')));
app.use('/ru/theory', express.static(path.join(__dirname, 'ru', 'theory')));
app.use(express.static(path.join(__dirname, 'src')));
app.use('/en/savchenko_en.pdf', express.static(path.join(__dirname, 'pdf/savchenko_en.pdf')));
app.use('/savchenko.pdf', express.static(path.join(__dirname, 'pdf/savchenko.pdf')));
app.use('/js', express.static(path.join(__dirname, 'js')));

// Home route to list all posts
app.get('/', eng_page);

app.get('/en', (req, res) => {
    res.redirect('/');
});

app.get(/^\/(\d+\.\d+\.\d+)$/, (req, res) => {
    const version = req.params[0]; // Capture the version part
    res.redirect(`/en/${version}`);
});


app.get('/ru', ru_page);

app.get('/en/about', (req, res) => {
    res.redirect(`/about#description`);
});

app.get('/about', (req, res) => {
    res.render('about_en'); 
});

app.get('/ru/about', (req, res) => {
    res.render('about_ru'); 
});

app.get('/:lang/:name', (req, res) => {
    const {
        lang,
        name
    } = req.params;

    if (/^(1[0-4]|[1-9])$/.test(lang)) {
        return res.redirect(`/ru/${name}`);
    }

    const filePath = path.join(__dirname, `posts/${lang}`, `${name}.md`);

    // Check if the specified file exists
    if (fs.existsSync(filePath)) {
        let fileContents = fs.readFileSync(filePath, 'utf8')
            .replace(/;/g, '\\;')
            .replace(/,/g, '\\,')
            .replace(/\*/g, '\\*')
            .replace(/~/g, '\\~');
        fileContents = transformImageMarkdown(fileContents);
        titleContent = getLineStatement(fileContents);
        console.log(titleContent)
        // console.log(getLineStatement(fileContents.replace('\^\\\*','').replace('$','')));//.replace('.$','.')
        // console.log(fileContents.replace('\^\\\*','').replace('$','').replace('.$','.'))
        let html = parseMarkdown(fileContents); // Convert Markdown to HTML
        html = html.replace(/<em>/g, '_').replace(/<\/em>/g, '_');
        html = html.replace(/\\\*/g, '*');


        const pageRef = name.split('.').slice(0, 2).join('.');

        res.render(lang === 'ru' ? 'post_ru' : 'post_en', {
            pageRef,
            title: name+'. '+titleContent,
            content: html
        });
    } else {
        res.status(404).render('404', {
            pageUrl: req.originalUrl
        })
    }
});


// Start the server
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
