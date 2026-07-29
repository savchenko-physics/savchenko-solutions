// Client-side guard. The server already withholds this file from traffic it classifies
// as automated (see the /js/analytics.js route in index.js); this is the second line of
// defence, and the hostname check is the ONLY thing that can stop cross-domain
// contamination — belpho.org, *.github.io and localhost all serve copies of this markup
// and report into the same property, which is why the GA numbers cannot currently be
// attributed to this site.
(function () {
    var host = location.hostname;
    if (host !== 'savchenkosolutions.com' && host !== 'www.savchenkosolutions.com') return;
    // A real browser always exposes at least one language. The browser farm sends no
    // Accept-Language header at all, and its JS context matches.
    if (!navigator.languages || navigator.languages.length === 0) return;
    if (navigator.webdriver) return;

(function(m,e,t,r,i,k,a){m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};
m[i].l=1*new Date();
for (var j = 0; j < document.scripts.length; j++) {if (document.scripts[j].src === r) { return; }}
k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)})
(window, document, "script", "https://mc.yandex.ru/metrika/tag.js", "ym");

ym(98395701, "init", {
    clickmap:true,
    trackLinks:true,
    accurateTrackBounce:true
});

(window, document, "script", "https://www.googletagmanager.com/gtag/js?id=G-DDMB38YMLD", "ym");
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());

gtag('config', 'G-DDMB38YMLD');

// Function to add Google Tag Manager to the head
function addGoogleTagManagerToHead() {
    var gtmScript = document.createElement('script');
    gtmScript.innerHTML = "(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':" +
    "new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0]," +
    "j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=" +
    "'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);" +
    "})(window,document,'script','dataLayer','GTM-MDXTLBLZ');";
    document.head.appendChild(gtmScript);
}

// Function to add Google Tag Manager noscript to the body
function addGoogleTagManagerNoscriptToBody() {
    var gtmNoscript = document.createElement('noscript');
    gtmNoscript.innerHTML = '<iframe src="https://www.googletagmanager.com/ns.html?id=GTM-MDXTLBLZ"' +
    ' height="0" width="0" style="display:none;visibility:hidden"></iframe>';
    document.body.insertBefore(gtmNoscript, document.body.firstChild);
}

// Execute functions to add GTM code
addGoogleTagManagerToHead();
addGoogleTagManagerNoscriptToBody();

    // Wrapping this file in an IIFE made gtag() a local. No live template calls it from
    // outside (the four inline gtag blocks elsewhere are all in dead files), but exposing
    // it costs nothing and removes the trap.
    window.gtag = gtag;
})();
