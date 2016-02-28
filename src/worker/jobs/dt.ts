import kue = require('kue')
import thenify = require('thenify')
import Promise = require('any-promise')
import semver = require('semver')
import { Minimatch } from 'minimatch'
import queue from '../../support/kue'
import db from '../../support/knex'

import { repoUpdated, commitsSince, commitFilesChanged, getFile, getDate } from './support/git'
import { createEntryAndVersion } from './support/db'

import {
  JOB_INDEX_DT_COMMIT,
  REPO_DT_PATH,
  REPO_DT_URL,
  TIMEOUT_REPO_POLL,
  JOB_INDEX_DT_FILE_CHANGE
} from '../../support/constants'

const VERSION_REGEXP_STRING = '\\d+\\.(?:\\d+|x)(?:\\.(?:\\d+|x)(?:\\-[^\\-\\s]+)?)?'

const DT_CONTENT_VERSION_REGEXP = new RegExp(`Type definitions for .* v?(${VERSION_REGEXP_STRING})$`, 'im')
const DT_CONTENT_PROJECT_REGEXP = /^\/\/ *Project: *([^\s]+)/im
const DT_FILE_VERSION_REGEXP = new RegExp(`-${VERSION_REGEXP_STRING}$`)

const definitionPaths = new Minimatch('**/*.d.ts')

/**
 * Job queue processing DefinitelyTyped repo data.
 */
export function updateDt (job: kue.Job) {
  return repoUpdated(REPO_DT_PATH, REPO_DT_URL, TIMEOUT_REPO_POLL)
    .then(() => processCommits(job))
}

/**
 * Process commits since last job.
 */
function processCommits (job: kue.Job) {
  const { commit } = job.data

  return commitsSince(REPO_DT_PATH, commit)
    .then(function (commits) {
      return Promise.all(commits.map(function (commit) {
        const commitJob = queue.create(JOB_INDEX_DT_COMMIT, { commit })
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

/**
 * Index DT commit changes.
 */
export function indexDtCommit (job: kue.Job) {
  const { commit } = job.data

  return repoUpdated(REPO_DT_PATH, REPO_DT_URL, TIMEOUT_REPO_POLL)
    .then(() => commitFilesChanged(REPO_DT_PATH, commit))
    .then(files => {
      return Promise.all(files.map(change => {
        const matched = definitionPaths.match(change[1])

        job.log(`Change (${matched ? 'matched' : 'not matched'}): ${change[0]} ${change[1]}`)

        if (!matched) {
          return
        }

        return thenify(cb => {
          const fileJob = queue.createJob(JOB_INDEX_DT_FILE_CHANGE, { change, commit })
          fileJob.removeOnComplete(true)
          fileJob.save(cb)
        })()
      }))
    })
}

/**
 * Index file changes sequentially.
 */
export function indexDtFileChange (job: kue.Job): Promise<any> {
  const source = 'dt'
  const { change, commit } = job.data
  const [ type, path ] = change

  if (type === 'D') {
    return getDate(REPO_DT_PATH, commit)
      .then(updated => {
        return db('versions')
          .del()
          .where('location', 'LIKE', getLocation(path, '%'))
          .andWhere('updated', '<', updated)
    })
  }

  const parts = path.toLowerCase().replace(/\.d\.ts$/, '').split('/')
  const filename = parts.pop()
  let name = filename.replace(DT_FILE_VERSION_REGEXP, '')
  let version: string = '0.0.0'
  let homepage: string

  // Extract the version from the filename.
  if (name !== filename) {
    version = normalizeVersion(filename.substr(name.length + 1)) || version
  }

  // Normalize non-project `.d.ts` files.
  if (parts.length > 2 || !isNameSimilar(name, parts[0])) {
    name = `${parts.join('/')}/${name}`
  }

  return repoUpdated(REPO_DT_PATH, REPO_DT_URL, TIMEOUT_REPO_POLL)
    .then(() => getFile(REPO_DT_PATH, path, commit, 1024))
    .then(contents => {
      const contentVersion = DT_CONTENT_VERSION_REGEXP.exec(contents)
      const contentHomepage = DT_CONTENT_PROJECT_REGEXP.exec(contents)

      // Update the known project version.
      if (contentVersion) {
        version = normalizeVersion(contentVersion[1]) || version
      }

      if (contentHomepage) {
        homepage = contentHomepage[1]
      }

      return getDate(REPO_DT_PATH, commit)
        .then(updated => {
          return createEntryAndVersion({
            name,
            updated,
            source,
            homepage,
            version,
            compiler: undefined,
            location: getLocation(path, commit)
          })
        })
    })
}

/**
 * Normalize possible version strings to semver.
 */
function normalizeVersion (version: string) {
  // Correct `4.x` notation.
  version = version.replace(/\.x(?=$|\.)/g, '.0')

  // Make it semver complete by appending `.0` when only two digits long.
  if (/^\d+\.\d+$/.test(version)) {
    version += '.0'
  }

  return semver.valid(version)
}

/**
 * Get the Typings location for DefinitelyTyped typings.
 */
function getLocation (path: string, commit: string) {
  return `github:DefinitelyTyped/DefinitelyTyped/${path.replace(/\\/g, '/')}#${commit}`
}

/**
 * Natively check if two possible names look similar by stripping off extra chars.
 */
function isNameSimilar (a: string, b?: string) {
  return typeof b === 'string' && sanitizeName(a) === sanitizeName(b)
}

/**
 * Strip extra name characters for comparison.
 */
function sanitizeName (name: string) {
  return name.replace(/[-\.]|js$/g, '')
}
