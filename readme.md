## Tdarr - One Flow - To Rule Them All

Goal to have One Flow (set of flows) to Rule all your Media!

I accomplish this by using Library Variables.  This allows us to change our quality and encoding settings in the library.  This is much easier than trying to edit the flow every time we want to encode differently.
I have a library for low quality, high quality, Animation, Movies.  Each has their own quality settings.  Then I just move the files I'm processing into the corresponding library folder and tdarr will process as needed.

- While I have ran thousands of files through this flow, please consider this beta! Do not trust it with your media library until you have ran a bunch of various files through it and understand how it operates!  Let me know if you run into unexpected behavior!
- Dolby Vision is safe: DV video is never re-encoded, only stream-copied (audio cleanup and default tracks still run). HDR10+ video is not re-encoded either (HEVC is skipped unless `do_hevc = true`). Works fine with basic HDR.
- NVENC is well tested.  QSV (Intel Arc / iGPU) is tested on thousands of files in this fork.  CPU works but needs more testing.
- Works with an input and output directory, or in place on an existing media library with `save_mode = replace` (see below).
- Uses the -vbr method to obtain a predictable bitrate.  With cq as a fallback method, or when we decide the bitrate is too low for -vbr to work well.

# Features
- Uses Library Variables for Quality Settings. This way you can have different libraries for different quality settings
- Uses Centralized Flow Variables for configurables in one location (1 - Input) No need to hunt the entire flow for configurables
- We calculate things like -maxrate based on your target bitrate. Simplifying user imput
- Lots of notes & documentation in the flow
- Extensive logging and use of icons to make tracking down failures a breeze
- Works with Nvidia, Intel QuickSync and CPU (Help me add others by sharing your ffmpeg command)
- Strip audio to where only the tracks you want remain
- If a lossless audio track exists, encode in opus (can disable, still needs refinement, as sometimes encodes high bitrate non-lossless tracks)
- Deinterlace .ts files. (tv DVR broadcasts)
- Export Embedded Subtitles (Could use more testing and refinement)
- Maximum output resolution (`v_max_resolution`): sources above it are downscaled, and the bitrate follows the target resolution's setting
- Maximum output bit depth (`v_max_bitdepth`): sources at or below it keep their native depth (e.g. 10-bit HDR stays 10-bit)
- Dolby Vision protection: DV sources (all profiles, including profile 5 with no HDR10 fallback) keep their video untouched
- Default tracks: the best English audio track becomes the default with no default subtitle; for foreign-language audio the English subtitle becomes the default (see Default Tracks below)
- Replace-in-place mode (`save_mode = replace`) for running against an existing library, with a Sonarr rescan/rename after each file and a skip gate so already-efficient files aren't re-encoded

  

I broke it down into 5 steps/flows:

1 - Input (Define Flow Variables & Configurables.  Tags files that may need special processing down the stack)

2 - Prep (Standardizes the File so it is less likely to fail encoding later)

3 - Audio (Clean audio and encode to Opus, if enabled)

4 - Video (Define desired bitrate by resolution, fall back on cq)

5 - Save (final checks and move operations)

# Installation
1. Create a new flow for each of the above steps (1-5) by:
   
    a. Go to Tdarr Flows

    b. Click "add flow"

    c. Scoll to bottom and copy/paste json into "Import JSON Template" 

3. Create a new Library with the Variables listed below (Make Sure your library has an input folder defined & output folders exist)
4. Profit

# Known Limitations
  - Dolby Vision video is copied, never re-encoded, so those files only shrink as much as audio cleanup allows.  HDR10+ is skipped as HEVC by default; with `do_hevc = true` it would be re-encoded and lose its HDR10+ metadata.
  - .ts files in 720p often end up with an unexpected bitrate.  Have not been able to figure out why yet.

# Replace-in-place Mode
Set `save_mode = replace` on a library pointed at an existing media library (instead of a download/input folder):
- The encoded file replaces the original atomically: it is copied into a hidden `.tdarr-partial/` folder next to the original (Sonarr, Plex and Jellyfin ignore dot-folders), verified, then renamed over the original, so the episode never disappears mid-replace.
- If the encode fails a review check (duration, size), it goes to `output_dir_review` and the original is **kept**.
- With `sonarr_url` / `sonarr_api_key` set, Sonarr rescans the series and renames the new file.
- A skip gate leaves files alone (default tracks only) when the video is already HEVC/AV1, or the source bitrate is below `low_bitrate_skip_ratio` (default 0.9) of the target for its resolution.

# Default Tracks
Every file that goes through the flow gets its default flags fixed with `mkvpropedit` (header only, no remux, takes about a second):
- The best English audio track (most channels, not commentary or descriptive) becomes the only default audio, and no subtitle is default. Forced flags are kept, so players still show forced subtitles when needed.
- If the default audio is explicitly non-English (a foreign film), its audio stays the default and the English full subtitle (not SDH or forced) becomes the default.
- An original is never edited in place if it lives under, or is hard-linked into, `protect_hardlinks_root` (default `/media/downloads`), so seeding torrents are never modified.

# Tweaks
- All the configurable Flow Settings can be edited in flow 1 - Input
- If you have an Nvidia 2000 series or up, enable flow plugin fl_nvenc_b-frames in the 1-Input flow. (1660 Super as well)
- You can disable audio processing with library variable do_audio = false

Library variables you need to add, with example setting:

# Variable Notes:
Audio bitrates and cutoff are set PER CHANNEL.  We use that to calculate based on number of channels in the audio stream.

# Required Fields
```
test_mode true # true = will not delete source file.  False = will delete source file.  Without source files won't delete.

output_dir_done /media/4_done # path from within tdarr

output_dir_review /media/4_done_review # if something didn't go right, we move to review folder.

v_cq 20 # quality setting for cq fallback method. Scale of 0-51.  Where 0 is lossless and 51 is the lowest quality.  16-18 is often considered indistinguishable.  18-24 is usually a sane range.

bitrate_480p 1250k # bitrate you want for given resolution

bitrate_576p 1400k

bitrate_720p 2000k

bitrate_1080p 2500k

bitrate_1440p 3800k

bitrate_4k 10000k

bitrate_4k_hdr 12500k

do_audio_clean - true - Remove Commentary Audio, Remove Languages not listed in "audio_language", Keep only the Audio Track with Highest Channel Count

do_audio_encode - true - Encode 1st Audio track to Opus

bitrate_audio 160k # Output audio bitrate we will encode to.  This is PER CHANNEL.

bitrate_audio_cutoff 192k # will not encode if source audio bitrate is under this value.  This is PER CHANNEL

audio_language und,un,eng,en,ger,deu,de,zho,zh,chi,jpn,ja,kor,ko,spa,es,cpe,  # languages that you want to keep, if blank it's skipped

```

# Optional Library Variable Fields

```
If not defined, the default is "false" (disabled)

disable_vbr = true # Disable Primary VBR encoding Method

disable_cq = true # Disable Fallback encoding method

disable_video = true # Optional - Only needed if you want to disable video processing - Set to True

do_hevc = true # process hevc?

encoder = nvenc/qsv/amf/vaapi/cpu - Override Encoder Autodetect and manually set what encoder to use (currently only nvenc/qsv/cpu work)

v_max_bitdepth = 8/10/12 # Maximum output bit depth. Sources at or below this depth keep their native depth; sources above are downconverted.

v_max_resolution = 480p/576p/720p/1080p/1440p/4k # Maximum output resolution. Sources above this are downscaled. Bitrate automatically uses the target resolution's settings.

save_mode = replace # Replace the library file in place instead of moving it to output_dir_done (see Replace-in-place Mode)

sonarr_url = http://sonarr:8989 # With save_mode = replace: Sonarr rescans the series and renames the replaced file

sonarr_api_key = <key> # With save_mode = replace

low_bitrate_skip_ratio = 0.9 # With save_mode = replace: skip encoding sources below this fraction of the target bitrate (default 0.9)

protect_hardlinks_root = /media/downloads # Default tracks never edit an original in place under, or hard-linked into, this folder (default /media/downloads)

```

# Quality Examples

Peoples opinions vary greatly on this.  Also content will have a big impact on what is optimal.  If you think you have good settings, share them!

## Low Quality:

```
v_cq 24 # quality setting for cq fallback method. Scale of 0-51.  Where 0 is lossless and 51 is the lowest quality.  16-18 is often considered indistinguishable.  18-24 is usually a sane range.

bitrate_480p 1250k # bitrate you want for given resolution

bitrate_576p 1400k

bitrate_720p 2000k

bitrate_1080p 2500k

bitrate_1440p 3800k

bitrate_4k 10000k

bitrate_4k_hdr 12500k

bitrate_audio 160k # Audio bitrate we will encode to.  This is PER CHANNEL.

bitrate_audio_cutoff 192k # will not encode source audio under this bitrate.  This is PER CHANNEL

```

## Mid-High Quality:

```
v_cq 20 # quality setting for cq fallback method. Scale of 0-51.  Where 0 is lossless and 51 is the lowest quality.  16-18 is often considered indistinguishable.  18-24 is usually a sane range.

bitrate_480p 1750k # bitrate you want for given resolution

bitrate_576p 2000k

bitrate_720p 3000k

bitrate_1080p 4000k

bitrate_1440p 6000k

bitrate_4k 17500k

bitrate_4k_hdr 20000k

bitrate_audio 256k # Audio bitrate we will encode to.  This is PER CHANNEL

bitrate_audio_cutoff 384k # will not encode source audio under this bitrate.  This is PER CHANNEL

```

## FAQ

Q: It was working but now it isn't.  The Variables aren't working anymore, but I do have them configured.  Log has message:  "Variable of value does not match condition == "

A: Sometimes a Tdarr update can break the existing Variables that you configured in the Library.  When this happens you need to re-save them to update the database.  You could delete them and re-add them, but the easiest way I have found is to simply add a space, " ", after the variable, then click another variable and it will save it.  After adding spaces to everything, go back and click on the variables and delete the spaces.  This will re-save the variables to the database and should correct the issue. 

Q:  Why is my video not encoding?  Why is it just copying the video?

A:  The most common reason for this is that your desired Output Bitrate is higher (or close to) your Input bitrate.  It wouldn't make sense to encode a 4000k video to 6000k.  When we encounter this we do go to the fallback cq encoding method, but this also checks to make sure a reasonable size savings can be obtained.  You can lower the quality by raising the cq value.
But keep in mind, it may not be worth it to encode such videos.  One-Flow probably won't encode if you only save 5% of space, the loss in quality wouldn't be worth a 5% space savings.  Keep it original, or lower the output bitrate.

Q:  Why are my hevc vides not encoding?

A:  By default we skip hevc, to force hevc encoding add the custom library variable: do_hevc = true.  In replace mode the skip gate also skips HEVC/AV1 (those files only get their default tracks fixed).

Q:  Will a Dolby Vision file still play on a device without Dolby Vision?

A:  The flow doesn't change that, because DV video is never re-encoded.  Profile 7 and 8 files carry an HDR10 base layer, so non-DV players play the HDR10 (and Plex/Jellyfin tone-map to SDR when needed).  Profile 5 has no HDR10 fallback and needs a DV-capable player or server-side tone mapping; re-encoding it would break its colours, which is why the flow leaves DV video alone.

## Flow Screenshot
The flow is huge, but here is an example.

![Video Example](https://github.com/samssausages/tdarr/blob/80ee7f3c63ab8f017eefac86c9a25f7f101f129a/video_example.png)
![Input Example](https://github.com/samssausages/tdarr/blob/80ee7f3c63ab8f017eefac86c9a25f7f101f129a/input_example.png)


## Release Notes

Changelog:

Fork changes (amlucent/Tdarr-One-Flow)

 - Added v_max_resolution (downscale above a maximum resolution, bitrate follows the target tier) and v_max_bitdepth, with a combined scale + deinterlace filter chain
 - Resolution and bit depth fall back to ffprobe when MediaInfo data is empty (previously every file landed on the 480p bitrate tier and HDR was encoded as 8-bit)
 - Added replace-in-place mode (save_mode = replace) with atomic replace, Sonarr rescan/rename, and a skip gate for HEVC/AV1 and low-bitrate sources
 - Dolby Vision video is stream-copied instead of re-encoded; audio cleanup and default tracks still run
 - Default audio/subtitle tracks are set on every processed file (English audio default, English subs for foreign-language audio)
 - The MKVPropEdit statistics refresh only runs on cache copies, never on source files; oversized encodes go to review
 - Fixed libx265 arguments, skip AV1 sources, encode mono Opus tracks at the 1-channel bitrate

V0.94

Not too many front end changes this relase, much is to prepare for future features.  Also squashed a few bugs.

 - Fixed bug that resulted in wrong bitrate during certain cirumstances
 - Backend changes to prepare for future features
 - Added better notifications for when encoding is skipped due to incompatible HDR

V0.93

BREAKING CHANGES:

Split "do_audio" into:

do_audio_clean - true/false - Remove Commentary Audio, Remove Languages not listed in "audio_language", Keep only the Audio Track with Highest Channel Count

do_audio_encode - true/false - Encode 1st Audio track to Opus


ACTION TO TAKE IF UPGRADING FROM OLD VERSION:

Remove "do_audio" Library Variable and create "do_audio_clean" and "do_audio_encode" Library Variables


OTHER CHANGES:

- is_audio_lossless custom JS - Expanding to capture more lossless audio codecs through the custom JS, for more durable lossless codec identification. - Still refining this
- Added optional library variable: "disable_vbr" - true/false - to disable vbr encoding method and force cq encoding. (if you have disable_cq enabled as well, then video encoding is skipped)
- Added optional library variable: "encoder" - nvenc/qsv/amf/vaapi/cpu - Override Autodetect and manually set what encoder to use (currently only nvenc/qsv/cpu work)
- Moved "lookahead=32" from 4 - Video to 1 - Input - Flow Variable "fl_cpu_main"

BUG FIX:

- Added missing error handling to audio cleaning process
- Improved Audio encode error reporting
