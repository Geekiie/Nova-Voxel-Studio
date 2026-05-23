# Nova - Voxel Studio

I wanted a program that lets me take basically **any 3D model** and turn it into a **voxelized Cube World Alpha `.cub` model**, then tweak it like a voxel editor and export it back out.

Right now the program is still pretty basic, but it’s in a workable state. A lot of the features / ideas are pulled from the Cube World community tools I’ve been using:
- **Cube World Voxel Model Maker (VMM)** (workflow / tools inspiration)
- **Cube World Tools / AssetBrowser** by **Ryan Stecker** (for browsing `data*.db` + preview assets)
- **Vox2Cub** by **ParanormalVibe** (reference for `.cub` exporting / structure)

Plus a few, random quality-of-life stuff I’ve added along the way.

I’ve only done a small amount of testing so far, so there are probably bugs, but it’s usable.

## What it runs off of
- Electron (desktop window)
- Vite (build tooling)
- Three.js (3D viewport + model importing)
- sql.js (reading Cube World `.db` files for the asset viewer)

## AI disclosure
This program (and some of the art assets/icons) were made with **a lot of help from AI tools**, then iterated and tested manually.

## Setup
You’ll need Node.js (LTS is fine).

Easiest way: just double click `Launch Nova - Voxel Studio.bat` once (it’ll install deps + build on the first run, then launch the app).

From the `Nova - Voxel Studio` folder:
```bat
npm install
npm run build
npm run desktop
```

### Quick workflow
- **Import** models from the File menu
- Voxelize model layers using the **voxelize button on the layer row**
- Use the tools panel to sculpt / recolor
- Export from File → Export Layer / Export Workspace

## Editing Cube World assets directly
On the right side of the UI:
1. Click **Set Root** and select your Cube World Alpha folder
2. Open **data1.db**
3. Find the asset you want
4. Drag it into the workspace to edit it
5. **Create Backup** before you replace anything
6. Right click an asset and choose **Replace with current layer**

## Backups
Backups only save the **.db file you currently have open** (not the entire Cube World folder).

## Troubleshooting
**Blank/gray window**
- Run `npm install` again
- Make sure `npm run build` finishes successfully before `npm run desktop`

**EPERM / permission weirdness (especially in OneDrive folders)**
- Try moving the folder somewhere outside OneDrive (like `C:\dev\NovaVoxelStudio`)
- Or force a local npm cache:
  ```bat
  set npm_config_cache=%cd%\.npm-cache
  npm install
  ```

## Credits
Huge credit to the Cube World modding community tools that made this possible (VMM / AssetBrowser / Vox2Cub).

Also big thanks to **ChrisMiuchiz** for a ton of the early Cube World / Alpha work that he's done.
