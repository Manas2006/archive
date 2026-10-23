# Google Drive setup (for your own build)

Archive can save PDFs to Google Drive, keep each project's `.bib` file there for Overleaf, and sync your library between the extension and the web app. It needs a Google OAuth client id for that. Official builds include one. If you build Archive yourself, follow these steps once. Without a client id, the Drive section in Settings just says Drive isn't available in this build.

Everything below uses one Google Cloud project and one OAuth client of type **Web application**, shared by the Chrome extension, the Firefox extension and the web app. Use the same client everywhere: Archive asks only for the `drive.file` scope, which lets it see the files it created itself, so the extension and the web app have to be the same app in Google's eyes to see each other's files (the sync file in particular).

## 1. Create a project and enable the Drive API

1. Go to <https://console.cloud.google.com/> and create a project (any name, for example "Archive").
2. Open **APIs & Services > Library**, search for **Google Drive API** and click **Enable**.

## 2. Set up the consent screen

Open **Google Auth Platform** (also reachable as **APIs & Services > OAuth consent screen**).

1. **Branding**: app name (for example "Archive"), a support email and a developer contact email.
2. **Audience**: user type **External**.
3. **Data access**: add exactly one scope, `https://www.googleapis.com/auth/drive.file` ("See, edit, create, and delete only the specific Google Drive files you use with this app"). Don't add anything else. Archive reads your account email through the Drive API's `about` endpoint, which `drive.file` already covers, so it needs no email or profile scope.

About verification: Google classifies `drive.file` as a **non-sensitive** scope ([Choose Google Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)). Apps that request only non-sensitive scopes don't need Google's full OAuth app verification; they can optionally go through the lighter brand verification, which is what makes your app name and logo show on the consent screen ([OAuth app verification](https://support.google.com/cloud/answer/13463073)). While the app's publishing status is **Testing**, only the test users you list under **Audience** can connect; click **Publish app** when you want anyone to be able to.

## 3. Create the OAuth client

Open **Google Auth Platform > Clients** (or **APIs & Services > Credentials > Create credentials > OAuth client ID**) and choose **Web application**.

**Authorized JavaScript origins** (for the web app):

- `https://<your-github-user>.github.io` (origin only, no path; for this repository that is `https://manas2006.github.io`)
- optionally your local dev server, for example `http://localhost:5173`

**Authorized redirect URIs** (for the extensions):

- **Chrome**: `https://<chrome-extension-id>.chromiumapp.org/` (with the trailing slash). Find the id on `chrome://extensions` with Developer mode on. An unpacked build gets a different id than the Chrome Web Store build, so register each id you use, or pin the id with a `key` in the manifest.
- **Firefox**: `http://127.0.0.1/mozoauth2/<hash>`, where `<hash>` is the SHA-1 of the add-on id in hex. For the gecko id `archive@manaspathak.com` that is:

  ```
  http://127.0.0.1/mozoauth2/d57e657686c020502195a309e772a067f8858b8f
  ```

  Why this form: in Firefox, `browser.identity.getRedirectURL()` returns `https://<hash>.extensions.allizom.org/`, here `https://d57e657686c020502195a309e772a067f8858b8f.extensions.allizom.org/`. Google can't verify ownership of `allizom.org`, so Firefox 86 and later also accept the loopback form above for the same extension, and Archive sends that one to Google ([Mozilla bug 1635344](https://bugzilla.mozilla.org/show_bug.cgi?id=1635344)). Google allows plain `http` only for loopback addresses, which is the case here.

  To find the hash for a different add-on id, either run `printf '%s' 'your-addon-id@example.com' | sha1sum`, or open `about:debugging` > **This Firefox** > Archive > **Inspect** and run `browser.identity.getRedirectURL()` in the console after Archive has the identity permission (connect once, or grant it from the add-on's permissions page). The hash is the first part of the host name. Keep the gecko id fixed (`browser_specific_settings.gecko.id` in the manifest), otherwise the redirect changes.

Save, then copy the **Client ID** (it looks like `1234567890-abc123.apps.googleusercontent.com`). You don't need the client secret: Archive never uses one. Google notes that changes to these settings can take from 5 minutes to a few hours to apply.

## 4. Build with the client id

The id is read at build time. The repository's `.env` holds the id of the official builds, which only works for the official extension ids and `manas2006.github.io`, so a fork needs its own. Put it in a `.env.local` file at the repository root (it wins over `.env` and is not committed):

```
WXT_GOOGLE_CLIENT_ID=1234567890-abc123.apps.googleusercontent.com
VITE_GOOGLE_CLIENT_ID=1234567890-abc123.apps.googleusercontent.com
```

`WXT_GOOGLE_CLIENT_ID` is for the extensions (`npm run build`, `npm run build:firefox`) and `VITE_GOOGLE_CLIENT_ID` for the web app (`npm run build:web`). For a fork's GitHub Pages deploy, change the ids in `.env` instead, since `.env.local` isn't committed. To build without Drive at all, set both to an empty value in `.env.local`.

The client id is **not a secret**. It is sent in the clear in every sign-in request and anyone can read it from the built files, so it is fine to commit it or put it in a public workflow. Google ties it to the origins and redirect URIs you registered, which is what keeps other sites from using it.

## 5. Try it

Open Settings > Google Drive > **Connect Google Drive**. Google asks to let Archive see and manage only the files it creates. After that, Settings shows "Connected as <your email>". Archive writes only under one folder in My Drive:

- `Archive/<project>/<citeKey>.pdf`: PDFs you save (or every new paper, if auto-save is on)
- `Archive/<project>/<project>.bib`: a project's bibliography, when you turn it on for Overleaf
- `Archive/.sync/library.json`: the library sync file

## Troubleshooting

- **Error 400: redirect_uri_mismatch**: the redirect URI isn't registered exactly. Google's error details show the one Archive sent; add exactly that (Chrome needs the trailing slash, Firefox the loopback form above).
- **Error 400: origin_mismatch** (web app): add the page's origin, without a path, under Authorized JavaScript origins.
- **Access blocked** or **This app isn't verified**: while the app is in Testing, add your account as a test user, or publish the app.
- **The sign-in window doesn't open on iPhone or iPad**: Safari only opens it right after a tap. Tap **Reconnect Google Drive** in Settings.

## Limitations

- Google access tokens last about an hour, and Archive has no refresh token (it never uses a client secret). The extension renews the token silently while you are signed in to Google in that browser. The web app can only renew it right after a tap, because Google's sign-in needs a popup; when the token runs out, sync pauses and Settings shows **Reconnect Google Drive**.
- The Firefox extension on Android has no identity API, so it can't connect to Drive. Use the web app there.
