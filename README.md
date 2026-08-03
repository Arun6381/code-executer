# EdxZone Code Runner

Self-hosted Docker-based code execution API. Unlimited, free, secure.

## How it works

```
Next.js App → POST /execute → Express Server → Docker Container → Result
```

Each code submission runs in an **isolated Docker container** with:
- No internet access (--network none)
- 128MB RAM limit
- 0.5 CPU limit
- 10 second timeout
- Read-only filesystem
- Auto-removed after execution

## Supported Languages

| Language   | Image              | Version  |
|------------|--------------------|----------|
| C          | gcc:13             | GCC 13   |
| C++        | gcc:13             | GCC 13   |
| Python     | python:3.12-slim   | 3.12     |
| Java       | openjdk:21-slim    | JDK 21   |
| JavaScript | node:20-slim       | Node 20  |

## Deploy Options

### Option 1: Railway (Easiest — Free tier available)
1. Push /code-runner folder to a GitHub repo
2. Go to railway.app → New Project → Deploy from GitHub
3. Set environment variable: ALLOWED_ORIGIN=https://edxzone.in
4. Railway gives you a URL like: https://code-runner-xxx.railway.app
5. Add to Vercel: NEXT_PUBLIC_CODE_RUNNER_URL=https://code-runner-xxx.railway.app

### Option 2: Render (Free tier)
1. Push to GitHub
2. New Web Service on render.com
3. Build: docker
4. Same env vars

### Option 3: Your own VPS (DigitalOcean, AWS EC2, etc.)
```bash
# On your server:
git clone <your-repo>
cd code-runner

# Pull language Docker images first (one time)
docker pull gcc:13
docker pull python:3.12-slim
docker pull openjdk:21-slim
docker pull node:20-slim

# Start
docker-compose up -d

# Check health
curl http://localhost:3001/health
```

## API Endpoints

### POST /execute
Run code with optional stdin.

```json
{
  "language": "python",
  "code": "print(input())",
  "stdin": "hello"
}
```

Response:
```json
{
  "stdout": "hello",
  "stderr": null,
  "compile_output": null,
  "status": "Accepted",
  "status_id": 3,
  "time": "0.045"
}
```

### POST /execute/batch
Run code against multiple test cases at once.

```json
{
  "language": "python",
  "code": "a,b=map(int,input().split()); print(a+b)",
  "test_cases": [
    { "input": "3 5", "expected_output": "8", "is_hidden": false },
    { "input": "10 20", "expected_output": "30", "is_hidden": false },
    { "input": "-5 5", "expected_output": "0", "is_hidden": true }
  ]
}
```

Response:
```json
{
  "status": "Accepted",
  "passed_count": 3,
  "total_count": 3,
  "compile_output": null,
  "results": [
    { "passed": true, "input": "3 5", "expected_output": "8", "actual_output": "8", "time": "0.041", "status": "Accepted", "is_hidden": false },
    { "passed": true, "input": "10 20", "expected_output": "30", "actual_output": "30", "time": "0.039", "status": "Accepted", "is_hidden": false },
    { "passed": true, "input": "-5 5", "expected_output": "0", "actual_output": "0", "time": "0.040", "status": "Accepted", "is_hidden": true }
  ]
}
```

### GET /languages
Returns list of supported languages.

### GET /health
Returns Docker status.

## Environment Variables

| Variable         | Default               | Description                  |
|------------------|-----------------------|------------------------------|
| PORT             | 3001                  | Server port                  |
| ALLOWED_ORIGIN   | *                     | CORS allowed origin          |

## Add to Vercel

```
NEXT_PUBLIC_CODE_RUNNER_URL=https://your-code-runner-url.railway.app
```

## Security

- Each run = fresh isolated container, auto-deleted after
- No network access inside containers
- Memory and CPU hard limits
- Process count limit (no fork bombs)
- Read-only filesystem (no file writes)
- Temp files cleaned up after each run
