# jpexs-web — SWF sprite / sound / script swap

Web client for JPEXS FFDec: upload a `.swf` → export assets → swap images/sounds/scripts → download the patched SWF.

- **Frontend (24/7):** https://graceus777.github.io/jpexs-web/ — local inspect + Ruffle preview in-browser, no server needed.
- **Backend (this repo):** `server.js` wraps local FFDec CLI. Writes (export/replace) need it.

## Backend 24/7 (Oracle ARM + Docker)

```bash
git clone https://github.com/Graceus777/jpexs-web.git && cd jpexs-web
echo "DOMAIN=your.host.org" > .env   # DNS A record -> this machine
sudo docker compose up -d --build
```

Caddy terminates HTTPS and proxies to `node server.js` + FFDec (`FFDEC_BIN=/opt/ffdec/ffdec.sh` in the image). Health: `https://your.host.org/api/health`.

Prereqs on the VM: Docker + compose plugin, ports 22/80/443 open (cloud security list AND local iptables), Ubuntu 24.04 aarch64, 2 OCPU / 12 GB.

## Local dev (Windows)

```powershell
npm install
pip install -r clipper/requirements.txt   # Python + Pillow, for POST /api/costume (image-to-clothing-SWF)
npm start   # http://localhost:3000, needs Java + FFDec (override: $env:FFDEC_BIN="...\ffdec-cli.exe")
npm test    # Node integration tests incl. live FFDec TOP/BOTTOMS compile when FFDec is installed
```

## Point the frontend at a backend

Open the page → *Backend + tags* → API base → paste `https://your.host.org` → **Use**. Empty = same-origin. (`https://` pages can only call `https://` backends.)
