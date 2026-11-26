# Sequence Table Dealer

A Sequence card dealer and board companion with two modes: local play on one device and private invite rooms. Online, each player sees their complete hand on their own device throughout the game; only the active player can place a token.

## Run locally

Open `index.html` in a browser, or start a local server from this folder:

```sh
python3 -m http.server 4173
```

Then visit `http://localhost:4173`.

## Multiplayer server

GitHub Pages hosts the browser app. Private rooms require the separate Node.js WebSocket server in `sequence-server`.

1. In Render, choose **New → Blueprint** and connect this repository. Render reads `render.yaml` and creates the `sequence-multiplayer` web service.
2. Wait for the service deployment to finish, then check `https://YOUR-SERVICE.onrender.com/health` for an `ok` response.
3. Open the GitHub Pages app. It is preconfigured with `https://sequence-multiplayer.onrender.com`; the **Multiplayer server** field can be changed to use another deployment. Friends can use the invite URL, which includes the room code and server address.

The free Render service may sleep when idle, so the first connection after inactivity can take a little longer. Room state is held in server memory; active rooms are not durable across service restarts.

Private-room players can see each other's chosen display names. The app has no text chat or account system.

## Publish with GitHub Pages

This repository is configured for Pages from the `main` branch root. After Pages finishes building, open the repository's **Settings → Pages** to find the public site URL.
