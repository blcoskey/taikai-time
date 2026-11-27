# Taikai Time

A live board and scoring tools for a kendo shiai, run from a Google Sheet.

- **The board** (`index.html`) is a plain web page, hosted here with GitHub Pages. It reads the scores from the sheet every 15 seconds.
- **The sheet and admin app** live in Google Apps Script (`apps-script/`). The scoring table uses the admin app, which saves to the sheet.

## Set up

1. Upload `apps-script/Shiai_template.xlsx` to Google Drive and open it with Google Sheets (File > Save as Google Sheets).
2. In the sheet, go to Extensions > Apps Script. Replace `Code.gs` with `apps-script/Code.gs`. Add an HTML file named `Index` with `apps-script/Index.html`, and one named `Admin` with `apps-script/Admin.html`. Save.
3. Reload the sheet and run **Shiai > Set up sheets**. Allow the permissions.
4. Deploy > New deployment > Web app. Execute as *Me*, Who has access *Anyone*. Copy the `/exec` link.
5. Paste that link into `config.js` here, between the quotes. The board on GitHub Pages now shows the real scores.
6. Change the Admin code on the Competitions tab (cell B2). The admin app is the `/exec` link with `?page=admin` on the end.

After changing the Apps Script code: Deploy > Manage deployments > Edit > New version. The link stays the same.

Until `config.js` has a link, the board shows a demo.
