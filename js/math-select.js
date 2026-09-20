// A formula inside a selection is painted like the text around it. The server typesets every
// formula to SVG (mathRender.js), and a browser does not highlight an inline SVG when the
// selection runs across it, so a selected paragraph showed its formulas as gaps (the owner,
// 2026-09-19). On every change of the selection each formula's container gets .mjx-selected
// when any part of it is selected; the stylesheet (/css/mathjax.css) paints it in the system
// selection colours. The TeX text the copy carries is the container's own (.mjx-tex).
(function () {
    'use strict';
    if (!window.getSelection || !document.addEventListener) return;
    var pending = false;
    function paint() {
        pending = false;
        var sel = window.getSelection();
        var live = sel && sel.rangeCount > 0 && !sel.isCollapsed;
        var nodes = document.querySelectorAll('mjx-container');
        for (var i = 0; i < nodes.length; i++) {
            var on = live && sel.containsNode(nodes[i], true);
            if (on !== nodes[i].classList.contains('mjx-selected')) nodes[i].classList.toggle('mjx-selected', on);
        }
    }
    document.addEventListener('selectionchange', function () {
        if (pending) return;
        pending = true;
        (window.requestAnimationFrame || setTimeout)(paint);
    });
})();
