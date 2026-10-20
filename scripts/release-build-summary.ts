// Buildx rawjson uses BuildKit SolveStatus.vertexes with RFC 3339 timestamps:
// https://github.com/moby/buildkit/blob/master/client/graph.go
import { appendFileSync, readFileSync } from 'node:fs'

type Vertex = {
  digest: string
  name?: string
  started?: string
  completed?: string
  error?: string
}

function summary(progress: string) {
  const vertices = new Map<string, Vertex>()
  for (const line of progress.split('\n').filter((line) => line.trim())) {
    const event = JSON.parse(line) as { vertexes?: Vertex[] }
    for (const vertex of event.vertexes ?? []) {
      vertices.set(vertex.digest, { ...vertices.get(vertex.digest), ...vertex })
    }
  }
  const rows = ['linux/amd64', 'linux/arm64'].map((platform) => {
    const matching = [...vertices.values()].filter((vertex) =>
      new RegExp(`^\\[${platform}(?:/v\\d+)?(?: |\\])`).test(vertex.name ?? ''),
    )
    const intervals = matching
      .filter((vertex) => vertex.started)
      .map((vertex) => {
        const start = Date.parse(vertex.started ?? '')
        const end = Date.parse(vertex.completed ?? '')
        if (vertex.error || !Number.isFinite(start) || !Number.isFinite(end) || end < start) {
          throw new Error('Incomplete or invalid platform build timing')
        }
        return { start, end }
      })
    if (!intervals.length) throw new Error(`Missing build timing for ${platform}`)
    const elapsed =
      Math.max(...intervals.map(({ end }) => end)) -
      Math.min(...intervals.map(({ start }) => start))
    return `| ${platform} | ${(elapsed / 1000).toFixed(1)} s |`
  })
  return [
    '## Release dry-run build durations',
    '',
    '| Platform | Elapsed build span |',
    '|---|---:|',
    ...rows,
    '',
    'First started to last completed platform-labelled BuildKit vertex, including cached steps.',
    'Platforms overlap; shared work and the final OCI/SBOM/provenance export are outside these spans.',
    'The multi-platform OCI image remains on the disposable runner; nothing was published.',
    '',
  ].join('\n')
}

if (import.meta.main) {
  const file = process.argv[2]
  const destination = process.env.GITHUB_STEP_SUMMARY
  if (!file || !destination) throw new Error('Expected a progress file and GITHUB_STEP_SUMMARY')
  appendFileSync(destination, summary(readFileSync(file, 'utf8')))
}
