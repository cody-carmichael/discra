# Discra Mobile (PR14-PR20)

Native mobile app for Admin/Dispatcher and Driver workflows using React Native + Expo.

## Current scope
- Admin/Dispatcher mobile workflow:
  - View order queue
  - Assign and unassign drivers
  - Update order status
  - Track active drivers (latest coordinates + timestamp)
  - In-app map visualization for active drivers
  - Route context panel for selected driver with `/routes/optimize` integration
  - Quick open for optimized navigation route in Google Maps
  - Session validation warnings for API/JWT/role mismatch
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
  - Hosted UI login/logout deep links (`discra-mobile://auth/callback`) using Authorization Code + PKCE
  - Offline queue for driver status/location events with manual sync (`Sync Queue`)
- Release hardening:
  - Expo EAS build profiles (`mobile/eas.json`)
  - Mobile CI typecheck workflow (`.github/workflows/mobile-ci.yml`)

## Run locally
```powershell
cd mobile
npm install
npm run start
npm run typecheck
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

## Route context note
- Route context uses backend route optimization for selected driver.
- If optimization is unavailable, the app falls back to assigned-order context display.

## Build and release profiles
`mobile/eas.json` includes:
- `development`: dev client, internal distribution
- `preview`: internal APK distribution
- `production`: store-ready build with auto increment

Example commands:
```powershell
cd mobile
npx eas build --platform android --profile preview
npx eas build --platform ios --profile production
```

## Mobile smoke test checklist
1. Login via Hosted UI and verify callback returns to app with token populated.
2. Validate workspace role gating:
   - Admin/Dispatcher token can refresh orders/drivers.
   - Driver token can refresh inbox and send location.
3. Driver location:
   - Send live location.
   - Disable network, send location, confirm queued count increments.
   - Re-enable network and run `Sync Queue`, confirm queue drains.
4. POD flow:
   - Capture photo and signature.
   - Submit POD and confirm order transitions to `Delivered`.
5. Admin map:
   - Active drivers render on map.
   - Selecting driver focuses map and updates route context panel.
6. Route quick action:
   - `Optimize Route` loads ordered stops and travel summary.
   - `Open Route in Maps` launches Google Maps direction intent for the optimized route.
