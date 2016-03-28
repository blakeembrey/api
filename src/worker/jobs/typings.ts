import kue = require('kue')
import thenify = require('thenify')
import { Minimatch } from 'minimatch'
import { repoUpdated, commitsSince, commitFilesChanged, getFile, getDate } from './support/git'
import { createEntry, createVersion, VersionOptions, deleteVersions } from './support/db'
import queue from '../../support/kue'

import {
  REPO_TYPINGS_PATH,
  REPO_TYPINGS_URL,
  JOB_INDEX_TYPINGS_COMMIT,
  JOB_INDEX_TYPINGS_FILE_CHANGE,
  TIMEOUT_REPO_POLL
} from '../../support/constants'

const registryPaths = new Minimatch('{npm,github,bower,common,shared,lib,env,global}/**/*.json')

/**
 * Job queue processing registry data.
 */
export function updateTypings (job: kue.Job) {
  return repoUpdated(REPO_TYPINGS_PATH, REPO_TYPINGS_URL, TIMEOUT_REPO_POLL)
    .then(() => processCommits(job))
}

/**
 * Process commits since last job.
 */
function processCommits (job: kue.Job) {
  const { commit } = job.data

  return commitsSince(REPO_TYPINGS_PATH, commit)
    .then(function (commits) {
      return Promise.all(commits.map(function (commit) {
        const commitJob = queue.create(JOB_INDEX_TYPINGS_COMMIT, { commit })
        commitJob.removeOnComplete(true)
        return thenify(cb => commitJob.save(cb))()
      }))
        .then(() => {
          return {
            commit: commits.pop() || commit
          }
        })
    })
}

export function indexTypingsCommit (job: kue.Job) {
  const { commit } = job.data

  return repoUpdated(REPO_TYPINGS_PATH, REPO_TYPINGS_URL, TIMEOUT_REPO_POLL)
    .then(() => commitFilesChanged(REPO_TYPINGS_PATH, commit))
    .then(files => {
      return Promise.all(files.map(change => {
        const matched = registryPaths.match(change[1])

        job.log(`Change (${matched ? 'matched' : 'not matched'}): ${change[0]} ${change[1]}`)

        if (!matched) {
          return
        }

        return thenify(cb => {
          const fileJob = queue.createJob(JOB_INDEX_TYPINGS_FILE_CHANGE, { change, commit })
          fileJob.removeOnComplete(true)
          fileJob.save(cb)
        })()
      }))
    })
}

export function indexTypingsFileChange (job: kue.Job) {
  const { change, commit } = job.data
  const [ type, path ] = change

  // Build up parts since npm registry has scopes (E.g. `@foo/bar`).
  const parts: string[] = path.replace(/\.json$/, '').split('/')
  const source = parts.shift()
  const name = parts.join('/')

  if (type === 'D') {
    return getDate(REPO_TYPINGS_PATH, commit)
      .then(updated => {
        return deleteVersions({ name, source, updated })
      })
  }

  return repoUpdated(REPO_TYPINGS_PATH, REPO_TYPINGS_URL, TIMEOUT_REPO_POLL)
    .then(() => getFile(REPO_TYPINGS_PATH, path, commit, 1024 * 400))
    .then(data => {
      // Handle bad JSON commits.
      try {
        return JSON.parse(data)
      } catch (e) {
        return {}
      }
    })
    .then(entry => {
      const { homepage, versions } = entry

      // Skip iterations where versions does not exist (E.g. old commits).
      if (!versions) {
        return
      }

      return getDate(REPO_TYPINGS_PATH, commit)
        .then(updated => {
          return createEntry({
            name,
            homepage,
            source,
            updated
          })
            .then((row) => {
              // Skip already updated entries.
              if (row == null) {
                return
              }

              const data: VersionOptions[] = Object.keys(versions).map((version) => {
                const value = versions[version]
                const redisKey = `${source}:${name}`

                if (typeof value === 'string') {
                  return {
                    version,
                    entryId: row.id,
                    location: value,
                    updated,
                    redisKey
                  }
                }

                return {
                  version,
                  entryId: row.id,
                  compiler: value.compiler,
                  location: value.location,
                  description: value.description,
                  updated,
                  redisKey
                }
              })

              return Promise.all(data.map(data => createVersion(data)))
            })
        })
    })
}
