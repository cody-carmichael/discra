# Discra Mobile (PR14)

Native mobile app for Admin/Dispatcher and Driver workflows using React Native + Expo.

## Current scope
- Admin/Dispatcher mobile workflow:
  - View order queue
  - Assign and unassign drivers
  - Update order status
  - Track active drivers (latest coordinates + timestamp)
- Driver mobile workflow:
  - View assigned inbox
  - Update status (`PickedUp`, `EnRoute`, `Failed`, `Delivered`)
  - Send GPS location updates
  - Optional auto-share every 60 seconds

## Run locally
```powershell
cd mobile
npm install
npm run start
```

Use Expo Go or simulator/emulator.

## API configuration
The app expects `API Base URL` in this form:
- `https://<api-id>.execute-api.<region>.amazonaws.com/dev/backend`

For local SAM:
- `http://127.0.0.1:3000/dev/backend`

Paste a valid Cognito JWT with matching role claims for each workspace.
