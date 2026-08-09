# Self-hosted video

Files here are served at `/video/<name>` by `index.js`, with Range support, so a
`<video>` element can seek. Nothing here is loaded from a third-party origin.

This directory exists because YouTube embedding is not always available. The LEX News
segment about the project (`cNSQZJMJFZs`) has embedding switched off by its owner —
the YouTube player answers any `<iframe>`, on either youtube.com or
youtube-nocookie.com, with "Playback on other websites has been disabled by the video
owner". YouTube's share dialog still offers an embed code for it; that code does not
work. Verified 2026-08-09 against two known-embeddable videos as controls.

## Making that segment play on the site

Put the file here as `lex-news.mp4` and the homepage picks it up on the next request —
`views/eng_page.ejs` calls `assetIfPresent('/video/lex-news.mp4')` and switches to a
self-hosted `<video>` the moment the file exists. No code change, no redeploy.

    scp lex-news.mp4 aws:/home/ubuntu/savchenko-solutions/video/lex-news.mp4

The segment is Scripps/LEX18's copyright, so host it only with their permission. The
alternative that needs no file at all is asking LEX to allow embedding, after which
`videoEmbeddable: false` comes out of `views/eng_page.ejs` and the YouTube facade works.
