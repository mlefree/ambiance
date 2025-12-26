We are testing Ambiance's part of intelligent music organization.

Create (if not existing) into scripts/ a test-mock-user.cjs file that :

- Remove if existing the folder ./mp3.gitignored, and copy ./mp3.gitignored.original to ./mp3.gitignored
- Build the app and run it locally with mode === 'mock-user'

Before the scenario, make sure the app have this 'mock-user' mode developped;
This mode means that API can be called (WARNING with the respect of 1 call per minute)
and modification can be done to the original files.
It should produce the ambiance.json file and reorganize the mp3 repo

Scenario is therefore

- cleaning everything with running test-mock-user.cjs
- let's run the app during 30 sec
- verifying what ambiance.json file into ./mp3.gitignored have been produced

Goals :

to have an ambiance.json created like :

```json 
{
  "tracks": [],
  "playlist": [
    "/Users/lep/Workspace/mlefree/ambiance/mp3.gitignored/<any available file>.mp3",
    "/Users/lep/Workspace/mlefree/ambiance/mp3.gitignored/<any available file>.mp3"
  ],
  "toProcess": [
    "/Users/lep/Workspace/mlefree/ambiance/mp3.gitignored/<any file that does NOT match the pattern expected artist-etc... >.mp3"
  ]
}
```

The 3 topics should be array of length < 20

1. `tracks` contains what has been read
2. `playlist` contains what should be read
3. `toProcess` contains what should be processed by api AND meta, in order to be renamed

because the mode is "mock-user", we expect after

- tracks empty (nothing played)
- playlist, full (but <= 20) of any files that match the excpected pattern
- toProcess, full also, but
  should not contain "Jamaluna/Peniche/Jamaluna-Peniche-#1-51 Fever-A#46628-B#120.mp3" that already match the pattern
  should not contain the others that have been processed by the app using the meta (if exists)
  (if no meta of artist exist) should not contain the others that have been processed by the app using the meta API (
  acoustid)
  (if metas have been found) should not contain the others that have been processed by the app using the mood

**IMPORTANT LIMITATION**: In mock-user mode (no GUI), the mood analyzer is NOT available because:

- Essentia.js mood analysis runs in the renderer process (browser context)
- mock-user mode has no GUI/renderer, so mood analysis cannot be performed
- All files will use fallback mood code `A#55555` instead of actual mood analysis
