const express      = require('express')
const cors         = require('cors')
const { v4: uuid } = require('uuid')
const { spawn }    = require('child_process')
const fs           = require('fs')
const path         = require('path')
const rateLimit    = require('express-rate-limit')

const app  = express()
const PORT = process.env.PORT || 3001

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '50kb' }))

const limiter = rateLimit({ windowMs: 60000, max: 60, message: { error: 'Too many requests.' } })
app.use('/execute', limiter)

// ── Language config ────────────────────────────────────────────────
const LANGUAGES = {
  c: {
    fileName: 'main.c',
    compile:  (dir) => ['gcc', ['-O2', '-o', path.join(dir,'prog'), path.join(dir,'main.c'), '-lm']],
    run:      (dir) => [path.join(dir,'prog'), []],
    timeout:  10,
  },
  cpp: {
    fileName: 'main.cpp',
    compile:  (dir) => ['g++', ['-O2', '-std=c++17', '-o', path.join(dir,'prog'), path.join(dir,'main.cpp'), '-lm']],
    run:      (dir) => [path.join(dir,'prog'), []],
    timeout:  10,
  },
  python: {
    fileName: 'main.py',
    compile:  null,
    run:      (dir) => ['python3', [path.join(dir,'main.py')]],
    timeout:  10,
  },
  java: {
    fileName: 'Main.java',
    compile:  (dir) => ['javac', [path.join(dir,'Main.java')]],
    run:      (dir) => ['java', ['-cp', dir, 'Main']],
    timeout:  15,
  },
  javascript: {
    fileName: 'main.js',
    compile:  null,
    // ── KEY FIX: pass --input-type=module flag removed, use plain node
    // stdin is piped directly — no /dev/stdin needed
    run:      (dir) => ['node', [path.join(dir,'main.js')]],
    timeout:  10,
  },
}

const TMP_DIR = '/tmp/code-runner'
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true })

// ── Run process with stdin piped directly ─────────────────────────
function runProcess(cmd, args, stdin, timeoutSecs) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '', timedOut = false

    const proc = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        HOME: '/tmp',
        LANG: 'en_US.UTF-8',
      },
    })

    const timer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGKILL')
    }, timeoutSecs * 1000)

    proc.stdout.on('data', d => { stdout += d.toString() })
    proc.stderr.on('data', d => { stderr += d.toString() })

    // ── KEY: write stdin directly to the process pipe ──
    if (stdin && stdin.length > 0) {
      proc.stdin.write(stdin)
    }
    proc.stdin.end()

    proc.on('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code ?? 1, timedOut })
    })

    proc.on('error', (err) => {
      clearTimeout(timer)
      resolve({ stdout: '', stderr: err.message, exitCode: -1, timedOut: false })
    })
  })
}

// ── Compile helper ─────────────────────────────────────────────────
async function compileCode(lang, dir) {
  if (!lang.compile) return null
  const [cmd, args] = lang.compile(dir)
  const result = await runProcess(cmd, args, '', 15)
  if (result.exitCode !== 0) {
    return result.stderr || result.stdout || 'Compilation failed'
  }
  return null
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

// ── POST /execute ─────────────────────────────────────────────────
app.post('/execute', async (req, res) => {
  const { language, code, stdin = '' } = req.body

  if (!language || !code)   return res.status(400).json({ error: 'language and code are required' })
  if (!LANGUAGES[language]) return res.status(400).json({ error: `Unsupported language: ${language}` })
  if (code.length > 50000)  return res.status(400).json({ error: 'Code too long (max 50KB)' })

  const lang = LANGUAGES[language]
  const dir  = path.join(TMP_DIR, uuid())
  fs.mkdirSync(dir, { recursive: true })

  try {
    fs.writeFileSync(path.join(dir, lang.fileName), code)

    const compileErr = await compileCode(lang, dir)
    if (compileErr !== null) {
      return res.json({
        stdout: null, stderr: null, compile_output: compileErr,
        status: 'Compilation Error', status_id: 6, time: null, memory: null,
      })
    }

    const [cmd, args] = lang.run(dir)
    const start  = Date.now()
    const result = await runProcess(cmd, args, stdin, lang.timeout)
    const elapsed = ((Date.now() - start) / 1000).toFixed(3)

    if (result.timedOut) {
      return res.json({
        stdout: null, stderr: 'Time Limit Exceeded', compile_output: null,
        status: 'Time Limit Exceeded', status_id: 5,
        time: `${lang.timeout}.000`, memory: null,
      })
    }

    const ok = result.exitCode === 0
    return res.json({
      stdout:         ok ? result.stdout : null,
      stderr:         !ok ? (result.stderr || result.stdout) : null,
      compile_output: null,
      status:         ok ? 'Accepted' : 'Runtime Error',
      status_id:      ok ? 3 : 11,
      time:           elapsed,
      memory:         null,
    })

  } finally { cleanup(dir) }
})

// ── POST /execute/batch ───────────────────────────────────────────
app.post('/execute/batch', async (req, res) => {
  const { language, code, test_cases = [] } = req.body

  if (!language || !code)   return res.status(400).json({ error: 'language and code are required' })
  if (!LANGUAGES[language]) return res.status(400).json({ error: `Unsupported language: ${language}` })
  if (test_cases.length > 20) return res.status(400).json({ error: 'Max 20 test cases per batch' })

  const lang = LANGUAGES[language]
  const dir  = path.join(TMP_DIR, uuid())
  fs.mkdirSync(dir, { recursive: true })

  try {
    fs.writeFileSync(path.join(dir, lang.fileName), code)

    const compileErr = await compileCode(lang, dir)
    if (compileErr !== null) {
      return res.json({
        compile_output: compileErr, status: 'Compilation Error',
        results: [], passed_count: 0, total_count: test_cases.length,
      })
    }

    const [cmd, args] = lang.run(dir)
    const results = []

    for (const tc of test_cases) {
      const start  = Date.now()
      const result = await runProcess(cmd, args, tc.input || '', lang.timeout)
      const elapsed = ((Date.now() - start) / 1000).toFixed(3)

      const actual   = (result.stdout || '').replace(/\r\n/g,'\n').trim()
      const expected = (tc.expected_output || '').replace(/\r\n/g,'\n').trim()
      const passed   = !result.timedOut && result.exitCode === 0 && actual === expected

      results.push({
        passed,
        input:           tc.input,
        expected_output: tc.expected_output,
        actual_output:   actual,
        stderr:          result.stderr || null,
        time:            elapsed,
        status:          result.timedOut ? 'Time Limit Exceeded'
                       : result.exitCode === 0 ? (passed ? 'Accepted' : 'Wrong Answer')
                       : 'Runtime Error',
        is_hidden: tc.is_hidden || false,
      })
    }

    const passedCount = results.filter(r => r.passed).length
    return res.json({
      compile_output: null,
      status:         passedCount === results.length ? 'Accepted' : 'Wrong Answer',
      results,
      passed_count:   passedCount,
      total_count:    results.length,
    })

  } finally { cleanup(dir) }
})

// ── GET /languages ─────────────────────────────────────────────────
app.get('/languages', (req, res) => {
  res.json(Object.keys(LANGUAGES).map(k => ({
    id: k,
    name: {
      c:'C (GCC)', cpp:'C++ 17', python:'Python 3',
      java:'Java', javascript:'JavaScript (Node.js)',
    }[k],
  })))
})

// ── GET /health ────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  // Quick JS stdin test
  const dir = path.join(TMP_DIR, uuid())
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir,'main.js'), 'const chunks=[]; process.stdin.on("data",d=>chunks.push(d)); process.stdin.on("end",()=>process.stdout.write(chunks.join("").trim()));')
  const r = await runProcess('node', [path.join(dir,'main.js')], 'ok', 5)
  cleanup(dir)
  res.json({
    status:    r.stdout === 'ok' ? 'ok' : 'error',
    languages: Object.keys(LANGUAGES),
    runtime:   'native (stdin via pipe)',
    node_stdin_test: r.stdout === 'ok' ? 'passed' : 'failed',
  })
})

app.listen(PORT, () => {
  console.log(`✅ EdxZone Code Runner on port ${PORT}`)
  console.log(`   Stdin mode: pipe (no /dev/stdin)`)
  console.log(`   Languages: ${Object.keys(LANGUAGES).join(', ')}`)
})
