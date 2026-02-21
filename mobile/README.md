# Discra Mobile (PR14-PR16)

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
  - POD workflow:
    - Capture delivery photo (camera)
    - Capture recipient signature
    - Add delivery notes
    - Submit to `/pod/presign` + `/pod/metadata` then mark delivered
- Mobile auth and resilience:
  - Hosted UI login/logout deep links (`discra-mobile://auth/callback`)
  - Offline queue for driver status/location events with manual sync (`Sync Queue`)

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

## Hosted UI mobile setup
Set these in app session:
- `Cognito Hosted UI Domain` (example: `your-domain.auth.us-east-1.amazoncognito.com`)
- `Cognito App Client ID`

In Cognito app client settings, add callback/logout URL:
- `discra-mobile://auth/callback`

## Permissions
- Camera: POD photo capture
- Location: driver tracking and POD location metadata
