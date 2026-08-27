# `dcp.live` participation URL options

Analyzed from the live page source at [https://dcp.live](https://dcp.live) on
2026-08-27. The page reads its configuration from standard query parameters,
so the configured URL itself can be encoded in a presentation's QR code.

## URL format

```text
https://dcp.live/?parameter=value&anotherParameter=value
```

Parameter names are case-sensitive. Values containing URLs, JSON, commas, or
other reserved characters should be percent-encoded. The examples below show
readable values where that makes the behavior easier to understand.

The current page supports 15 parameters.

## Account and payment

### `registrationKey`

- **Purpose:** Private registration key used to register the participant's
  browser as a DCP worker.
- **Value:** A DCP private key, represented as a hexadecimal string.
- **When omitted:** Uses the site's demo account registration key.
- **Example:** `registrationKey=0x...`
- **Behavior:** The page checks the value with `dcp.wallet.isPrivateKey`.
  Registration stops if the value is invalid.
- **Security:** This is secret material. Putting it in a QR URL exposes it to
  anyone who can view the QR code or URL and may also place it in browser
  history, analytics, proxy logs, screenshots, and referrer data. Use only a
  narrowly scoped, revocable key intended for public participant enrollment.

### `paymentAddress`

- **Purpose:** Account address that receives credits earned by participating
  workers.
- **Value:** A DCP wallet address.
- **When omitted:** Credits go to the site's built-in demo payment address.
- **Example:** `paymentAddress=0x...`
- **Visible effect:** The address is displayed below the worker controls.

## Work selection and concurrency

### `jobIds`

- **Purpose:** Restricts the worker to one or more specific jobs.
- **Value:** One job ID or a comma-separated list of job IDs.
- **When omitted:** The `jobIds` restriction is not added to the worker
  configuration.
- **Examples:**
  - `jobIds=jeHgigTXPURl6xMgUz9oNw`
  - `jobIds=jeHgigTXPURl6xMgUz9oNw,anotherJobId`
- **Parsing:** Surrounding whitespace is removed and empty entries are
  discarded.

### `maxSandboxes`

- **Purpose:** Sets the maximum number of concurrent worker sandboxes.
- **Value:** Integer.
- **Default:** `2`
- **Example:** `maxSandboxes=4`

## Resource utilization

### `cpuUtilization`

- **Purpose:** Sets the CPU utilization value passed to the worker.
- **Value:** Floating-point number.
- **Default:** `1`
- **Example:** `cpuUtilization=0.5`

### `gpuUtilization`

- **Purpose:** Sets the GPU utilization value passed to the worker.
- **Value:** Floating-point number.
- **Default:** `1`
- **Example:** `gpuUtilization=0`

### `cpuCores`

- **Purpose:** Sets the number of CPU cores exposed to the worker.
- **Value:** Integer.
- **When omitted:** No explicit CPU core limit is passed.
- **Example:** `cpuCores=4`

### `gpuCores`

- **Purpose:** Sets the number of GPU cores/devices exposed to the worker.
- **Value:** Integer.
- **When omitted:** No explicit GPU core limit is passed.
- **Example:** `gpuCores=1`

## Minimum wage thresholds

These four values become the worker's `minimumWage` configuration. Each is
parsed as a floating-point number and defaults to `0`.

### `minCPU`

- **Purpose:** Minimum acceptable CPU wage.
- **Example:** `minCPU=0.001`

### `minGPU`

- **Purpose:** Minimum acceptable GPU wage.
- **Example:** `minGPU=0.001`

### `minIn`

- **Purpose:** Minimum acceptable input-data wage.
- **Example:** `minIn=0.001`

### `minOut`

- **Purpose:** Minimum acceptable output-data wage.
- **Example:** `minOut=0.001`

The page does not document units for these thresholds; confirm them against
the DCP client/scheduler configuration used by the event.

## Job origins and compute groups

### `allowOrigins`

- **Purpose:** Controls which job origins the worker accepts.
- **Value:** The literal `any`, or a comma-separated list of origins.
- **Default:** `any`
- **Examples:**
  - `allowOrigins=any`
  - `allowOrigins=https://jobs.example.com,https://other.example`
- **Parsing:** Listed origins are split on commas and trimmed. The page passes
  the result as `{ any: [...] }`; `any` is represented internally as
  `{ any: [null] }`.

### `computeGroups`

- **Purpose:** Selects the DCP compute group or groups the participant joins.
- **Accepted forms:**
  1. One `joinKey,joinSecret` pair.
  2. A JSON array of objects with `joinKey` and `joinSecret` properties.
- **Default:** The site's built-in demo compute group.
- **Readable examples:**
  - `computeGroups=mykey,mysecret`
  - `computeGroups=[{"joinKey":"a","joinSecret":"x"},{"joinKey":"b","joinSecret":"y"}]`
- **Recommended encoded JSON example:**

  ```text
  computeGroups=%5B%7B%22joinKey%22%3A%22a%22%2C%22joinSecret%22%3A%22x%22%7D%5D
  ```

- **Parsing details:** JSON is attempted only when the decoded value begins
  with `[`. Invalid JSON, or a non-JSON value without a comma, silently leaves
  the demo group in place. In pair form, only the first two comma-separated
  fields are used.
- **Security:** A `joinSecret` embedded in a public QR code is public in
  practice. Use an event-specific, revocable secret with the least privileges
  needed.

### `leavePublicGroup`

- **Purpose:** Controls whether the worker leaves the public compute group.
- **Value:** `false` to remain in the public group; any other supplied value
  evaluates to `true`.
- **Default:** `true`
- **Example:** `leavePublicGroup=false`
- **Parsing detail:** Only the exact lowercase string `false` disables this
  option.

## Complete example

This readable example directs payment to an event account, restricts work to
one job and one compute group, allows two sandboxes at 50% CPU utilization,
disables GPU utilization, and leaves the public group:

```text
https://dcp.live/?registrationKey=0xREGISTRATION_KEY&paymentAddress=0xPAYMENT_ADDRESS&jobIds=JOB_ID&maxSandboxes=2&cpuUtilization=0.5&gpuUtilization=0&cpuCores=2&minCPU=0.001&allowOrigins=https%3A%2F%2Fjobs.example.com&computeGroups=event-key%2Cevent-secret&leavePublicGroup=true
```

Construct the production URL with a URL builder so values are encoded
correctly:

```js
const url = new URL("https://dcp.live/");
url.search = new URLSearchParams({
  registrationKey: "0xREGISTRATION_KEY",
  paymentAddress: "0xPAYMENT_ADDRESS",
  jobIds: "JOB_ID",
  maxSandboxes: "2",
  cpuUtilization: "0.5",
  gpuUtilization: "0",
  cpuCores: "2",
  minCPU: "0.001",
  allowOrigins: "https://jobs.example.com",
  computeGroups: "event-key,event-secret",
  leavePublicGroup: "true",
}).toString();
```

Encode the resulting `url.href` as the QR-code payload.

## Validation and operational cautions

- The page parses integer fields with `parseInt` and decimal fields with
  `parseFloat`, but does not enforce ranges or reject `NaN`. Test the final URL
  on representative participant devices before printing or presenting it.
- Unknown query parameters are ignored.
- Configuration is visible and editable by every participant. Query
  parameters are configuration, not an access-control boundary.
- The page automatically registers an unregistered browser on load. A
  participant must still press **Start** to begin working.
- Long JSON-based URLs produce denser QR codes. Prefer the single-group pair
  syntax when one group is sufficient, use a high error-correction level, and
  test scanning at the intended display distance.
- Defaults belong to the public demo setup. For an event, explicitly set the
  registration key, payment address, job selection, and compute group rather
  than relying on those defaults.

## Source note

These options are derived from the live page's `getWorkerParams()` function,
not from a versioned public API specification. Recheck the page source before
an event because the accepted parameters and defaults can change without
notice.
