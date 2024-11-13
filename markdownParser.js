const express = require('express');
const { marked } = require('marked');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const matter = require('gray-matter');

marked.setOptions({
  breaks: true,
  gfm: true,
  smartLists: true,
  headerIds: false,
  xhtml: false
});

const parseMarkdown = (markdownText) => {
  const { content, data } = matter(markdownText); // Extract content and frontmatter
  const htmlContent = marked(content);
  return { htmlContent, metadata: data };
};

const transformImageMarkdown = (htmlContent) => {
  const regex = /!\[(.*?)\]\(\.\.\/img\/(.*?)\/(.*?)\)/g;

  return htmlContent.replace(regex, (match, altText, folder, filename) => {
    return `<center>
      <figure>
        <img src="${filename}"
          loading="lazy" alt="${altText}" width="80%" />
        <figcaption>
          Animation of rod movement
        </figcaption>
      </figure>
      </center>`;
  });
};

const app = express();
const PORT = 3000;
app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));

fs.readdir('./posts', (err, files) => {
  files.forEach(file => {
    const name = file.split('.')[0];
    const filePath = path.join(__dirname, 'posts', file);
    const fileContents = fs.readFileSync(filePath, 'utf8');
    const { htmlContent, metadata } = parseMarkdown(fileContents); // Get HTML and metadata

    console.log(metadata); // For debugging, check the extracted metadata

    htmlContent = transformImageMarkdown(htmlContent);

    app.get(`/${name}`, (req, res) => {
      res.render('post', {
        title: metadata.title || name,
        date: metadata.date,
        author: metadata.author,
        content: htmlContent
      });
    });
  });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
