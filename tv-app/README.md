# ParveenBox TV app (webOS launcher)

This folder is the small app installed on the LG TV (`com.parveenbox.app`). It opens the
ParveenBox website and carries `webOSUserScripts/userScript.js`, which runs inside YouTube pages:
it removes ads, picks the best quality, and drives the full-screen player
(Down: episodes, Up: quality, Back: return to ParveenBox).

The user's own YouTube AdFree app (`youtube.leanback.v4`) is separate. Never replace it.

## Build and install

```
npm install -g @webos-tools/cli
ares-package tv-app -o .          # makes com.parveenbox.app_<version>_all.ipk
ares-setup-device                 # once: add the TV (Developer Mode app shows IP and passphrase)
ares-install -d <tv-name> com.parveenbox.app_<version>_all.ipk
```

You can also install the .ipk with webOS Dev Manager (Install button).

When you change the version, update `version` in `appinfo.json` and `?app=` in `index.html`.
