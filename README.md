# Taikai Time

A live board and scoring tools for a kendo shiai, run from a Google Sheet.

- **The board** (`index.html`) is a plain web page, hosted here with GitHub Pages. It reads the sheet directly every 15 seconds, so the sheet must be shared as "Anyone with the link: Viewer".
- **The admin app** lives in Google Apps Script (`apps-script/`). It is deployed for "Only myself", so only your Google account can score. There is no admin code.

## Set up

1. Upload `apps-script/Shiai_template.xlsx` to Google Drive and open it with Google Sheets (File > Save as Google Sheets).
2. In the sheet, go to Extensions > Apps Script. Replace `Code.gs` with `apps-script/Code.gs`. Add an HTML file named `Admin` with `apps-script/Admin.html`. Save.
3. Reload the sheet and run **Shiai > Set up sheets**. Allow the permissions.
4. Deploy > New deployment > Web app. Execute as *Me*, Who has access *Only myself*. The `/exec` link is the admin app.
5. Share the sheet: Share > General access > *Anyone with the link* > *Viewer*.
6. Run **Shiai > Update public board** once. The Board tab then updates itself whenever a score changes. Don't type in it.
7. Paste the sheet's link into `config.js` here, between the quotes. The board now shows the real scores.

After changing the Apps Script code: Deploy > Manage deployments > Edit > New version. The link stays the same.

Only the account that deployed the web app can score. For more scorers, sign in to that account on the scoring laptop, or redeploy with Who has access *Anyone with a Google account* and share the sheet with them as Editor.

The board never shows demo data. Until `config.js` has a sheet link, it says it is not connected yet.
