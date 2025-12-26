
We are testing Ambiance's part of intelligent music organization.

Create into scripts/ a test-mock-all.cjs file that :

- Remove if existing the folder ./mp3.gitignored, and copy ./mp3.gitignored.original to ./mp3.gitignored
- Build the app and run it locally with mode === 'mock-all'


Before the scenario, make sure the app have this 'mock-all' mode developped;
This mode means that NO API is call and NO modification is done to the original files.
It only produced the ambiance.json file.

Scenario is therefore

- cleaning everything with running test-mock-all.cjs
- let's run the app during 30 sec
- verifying what ambiance.json file into ./mp3.gitignored have been produced

Goals :

to have an ambiance.json created like :

```json 
{
  "tracks": [],
  "playlist": [
    "/Users/lep/Workspace/mlefree/ambiance/mp3.gitignored/<any available file>.mp3"
  ],
  "toProcess": [
    "/Users/lep/Workspace/mlefree/ambiance/mp3.gitignored/<any file that does NOT match the pattern expected artist-etc... >.mp3"
  ]
}
```
The 2 topics should be array of length < 20

1. `tracks` contains what has been red
2. `playlist` contains what should be red
3. `toProcess` contains what should be processed by api, or moods, or meta, in order to be renamed

because the mode is "mock-all", we expect after
- tracks empty (nothing played)
- playlist, full (but <= 20) of any files
- toProcess, full also, but should not containing "Jamaluna/Peniche/Jamaluna-Peniche-#1-51 Fever-A#46628-B#120.mp3" that already match the pattern
