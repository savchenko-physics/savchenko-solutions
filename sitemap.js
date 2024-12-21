const fs = require('fs');
const path = require('path');
const { formatISO, subDays, parseISO } = require('date-fns');

const postsDirectories = [
    path.join(__dirname, 'posts', 'en'),
    path.join(__dirname, 'posts', 'ru')
];

const recentSitemapPath = path.join(__dirname, 'public', 'sitemap_recent.xml');
const olderSitemapPath = path.join(__dirname, 'public', 'sitemap_1.xml');

function generateSitemaps() {
    const recentPosts = [];
    const olderPosts = [];
    const threeDaysAgo = subDays(new Date(), 3);

    postsDirectories.forEach(postsDirectory => {
        const files = fs.readdirSync(postsDirectory);
        files.forEach(file => {
            if (file.endsWith('.md')) {
                const filePath = path.join(postsDirectory, file);
                
                const stats = fs.statSync(filePath);
                const lastModified = stats.mtime;

                const postEntry = {
                    loc: `https://savchenkosolutions.com/${postsDirectory.includes('ru') ? 'ru' : 'en'}/${file.replace('.md', '')}`,
                    lastmod: formatISO(lastModified)
                };

                if (lastModified > threeDaysAgo) {
                    recentPosts.push(postEntry);
                } else {
                    olderPosts.push(postEntry);
                }
            }
        });
    });

    // Sort posts by last modified date
    recentPosts.sort((a, b) => new Date(b.lastmod) - new Date(a.lastmod));
    olderPosts.sort((a, b) => new Date(b.lastmod) - new Date(a.lastmod));

    const recentSitemapContent = `
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"
        xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xsi:schemaLocation="http://www.sitemaps.org/schemas/sitemap/0.9 http://www.sitemaps.org/schemas/sitemap/0.9/sitemap.xsd
        http://www.google.com/schemas/sitemap-image/1.1 http://www.google.com/schemas/sitemap-image/1.1/sitemap-image.xsd">
    ${recentPosts.map(post => `
        <url>
            <loc>${post.loc}</loc>
            <lastmod>${post.lastmod}</lastmod>
        </url>
    `).join('\n')}
</urlset>
    `.trim();

    const olderSitemapContent = `
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"
        xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xsi:schemaLocation="http://www.sitemaps.org/schemas/sitemap/0.9 http://www.sitemaps.org/schemas/sitemap/0.9/sitemap.xsd
        http://www.google.com/schemas/sitemap-image/1.1 http://www.google.com/schemas/sitemap-image/1.1/sitemap-image.xsd">
    ${olderPosts.map(post => `
        <url>
            <loc>${post.loc}</loc>
            <lastmod>${post.lastmod}</lastmod>
        </url>
    `).join('\n')}
</urlset>
    `.trim();

    // Check and write recent sitemap if content has changed
    if (!fs.existsSync(recentSitemapPath) || fs.readFileSync(recentSitemapPath, 'utf8') !== recentSitemapContent) {
        fs.writeFileSync(recentSitemapPath, recentSitemapContent);
    }

    // Check and write older sitemap if content has changed
    if (!fs.existsSync(olderSitemapPath) || fs.readFileSync(olderSitemapPath, 'utf8') !== olderSitemapContent) {
        fs.writeFileSync(olderSitemapPath, olderSitemapContent);
    }

    // Update the sitemap.xml with the current date and time
    const currentDate = new Date().toISOString();
    const recentSitemapLastMod = fs.existsSync(recentSitemapPath) ? fs.statSync(recentSitemapPath).mtime.toISOString() : currentDate;
    const olderSitemapLastMod = fs.existsSync(olderSitemapPath) ? fs.statSync(olderSitemapPath).mtime.toISOString() : currentDate;

    const sitemapIndexContent = `
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <sitemap>
        <loc>https://savchenkosolutions.com/sitemap_recent.xml</loc>
        <lastmod>${recentSitemapLastMod}</lastmod>
    </sitemap>
    <sitemap>
        <loc>https://savchenkosolutions.com/sitemap_1.xml</loc>
        <lastmod>${olderSitemapLastMod}</lastmod>
    </sitemap>
</sitemapindex>
    `;

    fs.writeFileSync(path.join(__dirname, 'public', 'sitemap.xml'), sitemapIndexContent.trim());
}

setInterval(() => {
    generateSitemaps();
}, 1000);