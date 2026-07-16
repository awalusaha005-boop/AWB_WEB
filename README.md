# AWB_WEB — SiCepat AWB Tracker (Web Edition)

Web app pelacakan resi/AWB berbasis Vercel (static + serverless functions).

## Menjalankan lokal
    npm install
    npm run dev        # via `vercel dev` di port 3000
    # atau:
    node dev-server.js

## Struktur
- `public/`       — front-end statis (index.html, app.js, style.css, dll)
- `api/`          — serverless functions (proxy tracking Biteship/Binderbyte)
- `dev-server.js` — server dev lokal

## Environment variables (set di Vercel → Settings → Environment Variables)
- `BITESHIP_SECRET`
- `BINDERBYTE_KEY`