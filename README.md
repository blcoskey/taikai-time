# Taikai Time

A live board and scoring tools for a kendo shiai, run from a Google Sheet.

- **The board** (`index.html`) is a plain web page, hosted here with GitHub Pages. It reads the sheet directly every 15 seconds, so the sheet must be shared as "Anyone with the link: Viewer".
- **The admin app** lives in Google Apps Script (`apps-script/`). It is deployed for "Only myself", so only your Google account can score. There is no admin code.

## Set up

1. Upload `apps-script/Shiai_template.xlsx` to Google Drive and open it with Google Sheets (File > Save as Google Sheets).
2. In the sheet, go to Extensions > Apps Script. Replace `Code.gs` with `apps-script/Code.gs`. Add an HTML file named `Admin` with `apps-script/Admin.html`. Save. (Later updates can be automatic, see below.)
3. Reload the sheet and run **Shiai > Set up sheets**. Allow the permissions.
4. Deploy > New deployment > Web app. Execute as *Me*, Who has access *Only myself*. The `/exec` link is the admin app.
5. Share the sheet: Share > General access > *Anyone with the link* > *Viewer*.
6. Run **Shiai > Update public board** once. The Board tab then updates itself whenever a score changes. Don't type in it.
7. Paste the sheet's link into `config.js` here, between the quotes. The board now shows the real scores.

## Automatic deploys

Once the one-time steps below are done, every push to `main` that changes `apps-script/` updates the admin app by itself (the **Deploy admin app** action). It pushes `Code.gs` and `Admin.html` to the Apps Script project and puts a new version on the existing web app deployment, so the `/exec` link stays the same and access stays *Only myself*. You can also run it by hand from the Actions tab.

One-time setup:

1. Turn on the Apps Script API for your Google account: https://script.google.com/home/usersettings
2. On your computer (needs Node.js), run `npx @google/clasp@2.4.2 login` and sign in with the Google account that owns the sheet. This writes `~/.clasprc.json`. Use this exact version so the file matches the action.
3. Find the script ID: open the sheet, Extensions > Apps Script, then Project Settings (gear icon) > IDs > Script ID.
4. In GitHub, go to Settings > Secrets and variables > Actions > New repository secret, and add:
   - `SCRIPT_ID`: the script ID from step 3.
   - `CLASPRC_JSON`: the whole contents of `~/.clasprc.json` from step 2.
5. Go to Actions > Deploy admin app > Run workflow to check it works.

`~/.clasprc.json` lets anyone who has it edit your Apps Script projects, so keep it out of the repo and only paste it into the secret. If the action ever says the login expired, repeat step 2 and update the secret.

Without the action, update by hand: paste the files in, then Deploy > Manage deployments > Edit > New version. The link stays the same.

Only the account that deployed the web app can score. For more scorers, sign in to that account on the scoring laptop, or redeploy with Who has access *Anyone with a Google account* and share the sheet with them as Editor.

The board never shows demo data. Until `config.js` has a sheet link, it says it is not connected yet.
