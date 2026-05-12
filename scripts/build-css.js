const fs = require('fs');
const path = require('path');

const cssDir = path.join(__dirname, '..', 'css');
const files = ['design-system.css', 'main_page.css', 'solutions.css'];

const output = files.map(f => {
    const filePath = path.join(cssDir, f);
    return `/* === ${f} === */\n` + fs.readFileSync(filePath, 'utf8');
}).join('\n\n');

fs.writeFileSync(path.join(cssDir, 'bundle.css'), output);
console.log('CSS bundle created: css/bundle.css');
