/*
 * Swaps the poster rendered by views/default/video_embed.ejs for a real YouTube
 * iframe on first click, and plays it in place.
 *
 * The point is that nothing is requested from youtube.com until someone asks for
 * it: the page renders and is fully usable behind a filter that blocks YouTube,
 * and a visitor who never plays the video pays nothing for it. youtube-nocookie
 * is used so no tracking cookie is set for people who do press play.
 */
(function () {
    "use strict";

    function play(trigger) {
        const videoId = trigger.getAttribute("data-video-id");
        if (!videoId) return;

        const start = parseInt(trigger.getAttribute("data-video-start"), 10);
        const params = ["autoplay=1", "rel=0", "modestbranding=1"];
        if (Number.isFinite(start) && start > 0) params.push(`start=${start}`);

        const iframe = document.createElement("iframe");
        iframe.className = "video-embed-frame";
        iframe.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?${params.join("&")}`;
        iframe.title = trigger.getAttribute("aria-label") || "";
        iframe.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
        iframe.allowFullscreen = true;
        iframe.setAttribute("frameborder", "0");

        const wrap = trigger.parentNode;
        wrap.classList.add("is-playing");
        wrap.replaceChild(iframe, trigger);
    }

    // Delegated, so embeds rendered after load work too.
    //
    // The selector requires data-video-id on purpose. A video whose owner has
    // disabled embedding is rendered by the same partial as a plain link to
    // YouTube, sharing the .video-embed-trigger class but carrying no id — and
    // that link must be left alone to navigate. Matching the class alone would
    // swallow its click and leave the card doing nothing at all.
    document.addEventListener("click", function (event) {
        const target = event.target;
        if (!target || typeof target.closest !== "function") return;
        const trigger = target.closest(".video-embed-trigger[data-video-id]");
        if (!trigger) return;
        event.preventDefault();
        play(trigger);
    });
})();
