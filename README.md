# Aura Browser

A strict privacy-first browser shell built with Electron.

## What it enforces

- No telemetry or sync services enabled from the app.
- Temporary, in-memory browsing partition (no persistent profile).
- Blocks known tracker domains.
- Blocks all third-party requests (first-party only).
- Denies all runtime permissions (camera, mic, notifications, geolocation, etc).
- Strips `Referer` and adds `DNT` + `Sec-GPC` on outgoing requests.

## Important privacy note

If you use an external search engine, your **search query** is still sent to that engine.  
This app prevents cross-site leakage and third-party tracking, but no client can make remote search completely zero-data to the selected engine itself.

## Run

```bash
npm install
npm start
```

## Search engines

Preconfigured: DuckDuckGo, Brave Search, Startpage, SearX, Google, Bing.

You can also use **Custom Template** with `%s`, for example:

`https://example.com/search?q=%s`
# zero-data-browser
