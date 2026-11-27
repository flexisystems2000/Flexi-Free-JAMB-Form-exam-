# Flexi CBT live proctoring and recording

## Scope and safety

This feature is being built only on `cloudflare-migration`. It must not change `main`, production candidates, or existing registration/schedule records.

Live monitoring and recording remain disabled until the media server, recording pipeline, private Dropbox storage, admin playback, retention job, and candidate notice/permission workflow have all been configured and tested. A browser checkbox is an acknowledgement, not independent proof of a parent/guardian's permission.

## Architecture

- Vercel serves the candidate and admin frontend only.
- Cloudflare Worker authenticates candidate sessions and admins, then issues short-lived LiveKit access tokens. LiveKit API credentials stay in Worker secrets.
- A self-hosted LiveKit SFU on a VPS handles real-time media. Candidates publish camera/microphone tracks to the room for their scheduled batch; admins receive subscribe-only tokens.
- LiveKit Egress runs separately from the SFU and records the room.
- A trusted uploader service on the VPS transfers completed recording files to a private Dropbox folder using Dropbox OAuth. Large media files must not be proxied through the Cloudflare Worker.
- Supabase stores recording metadata and links records to exam, batch, candidate/attempt, Dropbox file ID, size, and retention deadline. It must not store public playback URLs.
- The admin dashboard asks the Worker for an authenticated playback grant; the Worker checks admin access and obtains the file from Dropbox without making the Dropbox token or a public shared link visible to the browser.

## Batch rooms and token permissions

Room names are derived server-side from the configured exam ID and the candidate's verified batch. Candidate identities use the verified candidate ID.

- Candidate token: may join the assigned room, publish media, and may not subscribe to other participants.
- Admin token: may join the requested room and subscribe, but may not publish.
- The Worker only issues an admin room token if at least one non-expired attempt in that batch is currently in progress.
- Tokens are short-lived and never contain Dropbox credentials.

## Worker configuration

Required secrets/vars before enabling the feature:

- `LIVEKIT_URL` (public WebSocket URL for the self-hosted LiveKit server)
- `LIVEKIT_API_KEY` (secret)
- `LIVEKIT_API_SECRET` (secret)

The Worker routes added for the first integration stage are:

- `POST /api/cbt/livekit-token` — requires the candidate's existing CBT session and an explicit monitoring-consent acknowledgement.
- `POST /api/admin/livekit-token` — requires existing admin authentication and an active batch.

The token helper is in `worker/livekit-token.js`. The routes are not usable until the LiveKit credentials are configured.

## Recording and Dropbox

Dropbox is an archive, not the live media transport. The recording pipeline should:

1. Write a completed MP4 recording to a private staging directory on the VPS.
2. Upload it with Dropbox upload sessions (sequential chunks no larger than Dropbox's per-request limit).
3. Verify the completed Dropbox file metadata and size.
4. Insert/update the Supabase recording metadata row only after upload succeeds.
5. Remove the VPS staging file after successful upload.
6. Retry interrupted uploads safely without creating duplicate recordings.

The Dropbox OAuth app needs the minimum `files.content.write` scope for upload and the corresponding read/delete scopes only if the chosen playback and retention design requires them. Use offline OAuth and keep the refresh token in the VPS secret store. Never commit app secrets or tokens.

## Retention and playback

- Retention is 30 days from recording completion.
- A scheduled trusted job must delete the Dropbox object and then mark the metadata row deleted. Failures must be retried and surfaced to admins.
- Admin playback must be authenticated and short-lived. Do not create public Dropbox shared links.
- Recordings should be encrypted in transit; access should be logged with admin identity, recording ID, and timestamp.
- Do not start recording until the candidate notice and required parent/guardian permission process has been reviewed and the candidate acknowledgement is persisted server-side.

## Remaining implementation stages

1. Finish the candidate LiveKit client integration using the existing camera/microphone stream.
2. Add an admin batch monitor with a five-candidate grid and per-candidate audio controls.
3. Provision the VPS, LiveKit SFU, and separate Egress service.
4. Build the Dropbox uploader and secure playback proxy on the VPS/Worker boundary.
5. Add the Supabase recording metadata schema with strict service-side access.
6. Add the 30-day deletion job, retries, audit events, and failure alerts.
7. Test with the isolated test candidate and test batch only. Do not enable real candidate recording until all acceptance checks pass.
