# Flexi Free JAMB Form Exam

Mobile-first CBT platform for the Flexi Educational Consult
Free JAMB Form Initiative.

## Existing registration source

Firebase project:

free-jamb-form-initiative

Firestore collection:

jamb_registrations

The CBT reads these existing fields:

- registrationNumber
- fullName
- whatsappNumber
- jambSubjects
- examSchedule

The CBT must not modify the original registration or schedule records.

## Technology

- Vercel serverless API
- Firebase Admin SDK
- Firestore
- Firebase Realtime Database for live status
- Cloudflare Realtime for live media
- Cloudflare R2 for protected recording storage

## Environment variables

Configure these in Vercel:

FIREBASE_SERVICE_ACCOUNT_JSON
FIREBASE_DATABASE_URL
CBT_EXAM_ID
CBT_START_WINDOW_SECONDS

Never commit Firebase credentials to GitHub.

## Current implementation

- Mobile-friendly candidate verification page
- Server-side registration lookup
- Saved subject retrieval
- Saved schedule retrieval
- Server-time eligibility check
- Existing attempt lookup
- API health endpoint

## Upcoming implementation

1. Secure attempt creation and locking
2. Instructions and consent page
3. CBT question delivery
4. Progressive answer saving
5. 50-minute server-controlled timer
6. Camera and microphone checks
7. Live proctoring
8. Recording and protected storage
9. Admin monitoring dashboard
10. Results and examination reports
