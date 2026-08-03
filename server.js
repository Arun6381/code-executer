const express    = require('express')
const cors       = require('cors')
const { v4: uuid } = require('uuid')
const { execSync, spawn } = require('child_process')
const fs         = require('fs')
const path       = require('path')
const rateLimit  = require('express-rate-limit')

const app  = express()
const PORT = process.env.PORT || 3001

// ── Middleware ────────────────────────────────────────────────────
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }))
app.use(express.json({ limit: '50kb' }))

// Rate limit: 60 requests per minute per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests, please slow down.' },
})
app.use('/execute', limiter)

// ── Language config ───────────────────────────────────────────────
const LANGUAGES = {
  c: {
    image:    'gcc:13',
    fileName: 'main.c',
    compile:  (file) => `gcc -O2 -o /sandbox/prog /sandbox/${file} -lm`,
    run:      () => '/sandbox/prog',
    timeout:  10,
  },
  cpp: {
    image:    'gcc:13',
    fileName: 'main.cpp',
    compile:  (file) => `g++ -O2 -std=c++17 -o /sandbox/prog /sandbox/${file} -lm`,
    run:      () => '/sandbox/prog',
    timeout:  10,
  },
  python: {
    image:    'python:3.12-slim',
    fileName: 'main.py',
    compile:  null,
    run:      (file) => `python3 /sandbox/${file}`,
    timeout:  10,
  },
  java: {
    image:    'openjdk:21-slim',
    fileName: 'Main.java',
    compile:  (file) => `javac /sandbox/${file}`,
    run:      () => 'java -cp /sandbox Main',
    timeout:  15,
  },
  javascript: {
    image:    'node:20-slim',
    fileName: 'main.js',
    compile:  null,
    run:      (file) => `node /sandbox/${file}`,
    timeout:  10,
  },
}

// ── Temp dir ──────────────────────────────────────────────────────
const TMP_DIR = '/tmp/code-runner'
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true })

// ── Execute in Docker ─────────────────────────────────────────────
function runInDocker({ image, sandboxDir, command, stdin, timeout }) {
  return new Promise((resolve) => {
    const stdinFile = path.join(sandboxDir, '__stdin__')
    fs.writeFileSync(stdinFile, stdin || '')

    const dockerCmd = [
      'docker', 'run',
      '--rm',                          // auto remove
      '--network', 'none',             // no internet access
      '--memory', '128m',              // 128MB RAM limit
      '--memory-swap', '128m',         // no swap
      '--cpus', '0.5',                 // half CPU
      '--pids-limit', '50',            // max 50 processes
      '--ulimit', 'nofile=64:64',      // file descriptors
      '--read-only',                   // read-only filesystem
      '--tmpfs', '/tmp:size=10m',      // writable /tmp only
      '-v', `${sandboxDir}:/sandbox:ro`, // mount code read-only
      '-i',                            // stdin
      image,
      'sh', '-c', `${command} < /sandbox/__stdin__ 2>&1`
    ]

    let output = ''
    let timedOut = false

    const proc = spawn(dockerCmd[0], dockerCmd.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe']
    })

    const timer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGKILL')
    }, timeout * 1000)

    proc.stdout.on('data', d => { output += d.toString() })
    proc.stderr.on('data', d => { output += d.toString() })

    proc.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        output:   output.trim(),
        exitCode: code,
        timedOut,
      })
    })

    proc.on('error', (err) => {
      clearTimeout(timer)
      resolve({ output: err.message, exitCode: -1, timedOut: false })
    })
  })
}

// ── POST /execute ─────────────────────────────────────────────────
app.post('/execute', async (req, res) => {
  const { language, code, stdin = '' } = req.body

  // Validation
  if (!language || !code) {
    return res.status(400).json({ error: 'language and code are required' })
  }
  if (!LANGUAGES[language]) {
    return res.status(400).json({ error: `Unsupported language: ${language}. Supported: ${Object.keys(LANGUAGES).join(', ')}` })
  }
  if (code.length > 50000) {
    return res.status(400).json({ error: 'Code too long (max 50KB)' })
  }

  const lang       = LANGUAGES[language]
  const runId      = uuid()
  const sandboxDir = path.join(TMP_DIR, runId)
  fs.mkdirSync(sandboxDir, { recursive: true })

  try {
    // Write code file
    const codeFile = path.join(sandboxDir, lang.fileName)
    fs.writeFileSync(codeFile, code)
    fs.writeFileSync(path.join(sandboxDir, '__stdin__'), stdin)

    let compileErr = null

    // ── Compile step (C, C++, Java) ──────────────────────────────
    if (lang.compile) {
      const compileResult = await runInDocker({
        image:      lang.image,
        sandboxDir,
        command:    lang.compile(lang.fileName),
        stdin:      '',
        timeout:    15,
      })

      if (compileResult.exitCode !== 0) {
        return res.json({
          stdout:     null,
          stderr:     null,
          compile_output: compileResult.output,
          status:     'Compilation Error',
          status_id:  6,
          time:       null,
          memory:     null,
        })
      }
    }

    // ── Run step ──────────────────────────────────────────────────
    const start   = Date.now()
    const result  = await runInDocker({
      image:      lang.image,
      sandboxDir,
      command:    lang.run(lang.fileName),
      stdin,
      timeout:    lang.timeout,
    })
    const elapsed = ((Date.now() - start) / 1000).toFixed(3)

    if (result.timedOut) {
      return res.json({
        stdout:         null,
        stderr:         'Time Limit Exceeded',
        compile_output: null,
        status:         'Time Limit Exceeded',
        status_id:      5,
        time:           `${lang.timeout}.000`,
        memory:         null,
      })
    }

    const ok = result.exitCode === 0

    return res.json({
      stdout:         ok ? result.output : null,
      stderr:         !ok ? result.output : null,
      compile_output: null,
      status:         ok ? 'Accepted' : 'Runtime Error',
      status_id:      ok ? 3 : 11,
      time:           elapsed,
      memory:         null,
    })

  } catch (err) {
    return res.status(500).json({ error: err.message })
  } finally {
    // Cleanup temp dir
    try { fs.rmSync(sandboxDir, { recursive: true, force: true }) } catch {}
  }
})

// ── POST /execute/batch ───────────────────────────────────────────
// Run same code against multiple test cases
app.post('/execute/batch', async (req, res) => {
  const { language, code, test_cases = [] } = req.body

  if (!language || !code) {
    return res.status(400).json({ error: 'language and code are required' })
  }
  if (!LANGUAGES[language]) {
    return res.status(400).json({ error: `Unsupported language: ${language}` })
  }
  if (test_cases.length > 20) {
    return res.status(400).json({ error: 'Max 20 test cases per batch' })
  }

  const lang       = LANGUAGES[language]
  const runId      = uuid()
  const sandboxDir = path.join(TMP_DIR, runId)
  fs.mkdirSync(sandboxDir, { recursive: true })

  try {
    const codeFile = path.join(sandboxDir, lang.fileName)
    fs.writeFileSync(codeFile, code)
    fs.writeFileSync(path.join(sandboxDir, '__stdin__'), '')

    // Compile once if needed
    if (lang.compile) {
      const compileResult = await runInDocker({
        image: lang.image, sandboxDir,
        command: lang.compile(lang.fileName),
        stdin: '', timeout: 15,
      })
      if (compileResult.exitCode !== 0) {
        return res.json({
          compile_output: compileResult.output,
          status: 'Compilation Error',
          results: [],
        })
      }
    }

    // Run against each test case
    const results = []
    for (const tc of test_cases) {
      fs.writeFileSync(path.join(sandboxDir, '__stdin__'), tc.input || '')
      const start  = Date.now()
      const result = await runInDocker({
        image: lang.image, sandboxDir,
        command: lang.run(lang.fileName),
        stdin: tc.input || '',
        timeout: lang.timeout,
      })
      const elapsed = ((Date.now() - start) / 1000).toFixed(3)

      const actual   = (result.output || '').trim()
      const expected = (tc.expected_output || '').trim()
      const passed   = !result.timedOut && result.exitCode === 0 && actual === expected

      results.push({
        passed,
        input:           tc.input,
        expected_output: tc.expected_output,
        actual_output:   actual,
        time:            elapsed,
        status:          result.timedOut ? 'TLE' : result.exitCode === 0 ? 'Accepted' : 'Runtime Error',
        is_hidden:       tc.is_hidden || false,
      })
    }

    const allPassed = results.every(r => r.passed)
    return res.json({
      compile_output: null,
      status:         allPassed ? 'Accepted' : 'Wrong Answer',
      results,
      passed_count:   results.filter(r => r.passed).length,
      total_count:    results.length,
    })

  } catch (err) {
    return res.status(500).json({ error: err.message })
  } finally {
    try { fs.rmSync(sandboxDir, { recursive: true, force: true }) } catch {}
  }
})

// ── GET /languages ────────────────────────────────────────────────
app.get('/languages', (req, res) => {
  res.json(Object.keys(LANGUAGES).map(k => ({
    id:      k,
    name:    { c:'C (GCC 13)', cpp:'C++ 17 (GCC 13)', python:'Python 3.12', java:'Java 21', javascript:'JavaScript (Node 20)' }[k],
    version: { c:'GCC 13', cpp:'GCC 13', python:'3.12', java:'21', javascript:'Node 20' }[k],
  })))
})

// ── GET /health ───────────────────────────────────────────────────
app.get('/health', (req, res) => {
  try {
    execSync('docker info', { stdio: 'ignore' })
    res.json({ status: 'ok', docker: true, languages: Object.keys(LANGUAGES) })
  } catch {
    res.status(503).json({ status: 'error', docker: false })
  }
})

app.listen(PORT, () => {
  console.log(`✅ EdxZone Code Runner running on port ${PORT}`)
  console.log(`   Languages: ${Object.keys(LANGUAGES).join(', ')}`)
})
