import * as core from '@actions/core'
import {context, GitHub} from '@actions/github'
import minimatch from 'minimatch'
import * as fs from 'fs/promises'
import * as path from 'path'

type Format = 'space-delimited' | 'csv' | 'json'
type FileStatus = 'added' | 'modified' | 'removed' | 'renamed'

async function run(): Promise<void> {
  try {
    // Create GitHub client with the API token.
    const client = new GitHub(core.getInput('token', {required: true}))
    const format = core.getInput('format', {required: true}) as Format
    const filter = core.getMultilineInput('filter', {required: true}) || '*'
    const writeFilesDir = core.getInput('output-dir', {required: false})

    // Ensure that the format parameter is set properly.
    if (format !== 'space-delimited' && format !== 'csv' && format !== 'json') {
      core.setFailed(`Format must be one of 'string-delimited', 'csv', or 'json', got '${format}'.`)
    }

    // Debug log the payload.
    core.debug(`Payload keys: ${Object.keys(context.payload)}`)

    // Get event name.
    const eventName = context.eventName

    // Define the base and head commits to be extracted from the payload.
    let base: string | undefined
    let head: string | undefined

    switch (eventName) {
      case 'pull_request_target':
      case 'pull_request':
        base = context.payload.pull_request?.base?.sha
        head = context.payload.pull_request?.head?.sha
        break
      case 'push':
        base = context.payload.before
        head = context.payload.after
        break
      default:
        core.setFailed(
          `This action only supports pull requests and pushes, ${context.eventName} events are not supported. ` +
            "Please submit an issue on this action's GitHub repo if you believe this in correct."
        )
    }

    // Log the base and head commits
    core.info(`Base commit: ${base}`)
    core.info(`Head commit: ${head}`)

    // Ensure that the base and head properties are set on the payload.
    if (!base || !head) {
      core.setFailed(
        `The base and head commits are missing from the payload for this ${context.eventName} event. ` +
          "Please submit an issue on this action's GitHub repo."
      )

      // To satisfy TypeScript, even though this is unreachable.
      base = ''
      head = ''
    }

    // Use GitHub's compare two commits API.
    // https://developer.github.com/v3/repos/commits/#compare-two-commits
    const response = await client.repos.compareCommits({
      base,
      head,
      owner: context.repo.owner,
      repo: context.repo.repo
    })

    // Ensure that the request was successful.
    if (response.status !== 200) {
      core.setFailed(
        `The GitHub API for comparing the base and head commits for this ${context.eventName} event returned ${response.status}, expected 200. ` +
          "Please submit an issue on this action's GitHub repo."
      )
    }

    const files = response.data.files.filter(file => {
      let match = false
      for (const item of filter) {
        const pattern = item
        core.debug(`Test ${file.filename} against ${pattern}`)
        core.debug(`current match value: ${match}`)
        if (pattern.startsWith('!')) {
          match = match && minimatch(file.filename, pattern, {matchBase: true, dot: true})
        } else {
          match = match || minimatch(file.filename, pattern, {matchBase: true, dot: true})
        }
        core.debug(`match: ${match}`)
      }
      return match
    })

    const all = [] as string[],
      added = [] as string[],
      modified = [] as string[],
      removed = [] as string[],
      renamed = [] as string[],
      addedModified = [] as string[],
      addedModifiedRenamed = [] as string[]
    for (const file of files) {
      const filename = file.filename
      // If we're using the 'space-delimited' format and any of the filenames have a space in them,
      // then fail the step.
      if (format === 'space-delimited' && filename.includes(' ')) {
        core.setFailed(
          `One of your files includes a space. Consider using a different output format or removing spaces from your filenames. ` +
            "Please submit an issue on this action's GitHub repo."
        )
      }
      all.push(filename)
      switch (file.status as FileStatus) {
        case 'added':
          added.push(filename)
          addedModified.push(filename)
          addedModifiedRenamed.push(filename)
          break
        case 'modified':
          modified.push(filename)
          addedModified.push(filename)
          addedModifiedRenamed.push(filename)
          break
        case 'removed':
          removed.push(filename)
          break
        case 'renamed':
          renamed.push(filename)
          addedModifiedRenamed.push(filename)
          if (file.patch) {
            // modified renamed files include a patch field
            modified.push(filename)
            addedModified.push(filename)
          }
          break
        default:
          core.setFailed(
            `One of your files includes an unsupported file status '${file.status}', expected 'added', 'modified', 'removed', or 'renamed'.`
          )
      }
    }

    // Format the arrays of changed files.
    let allFormatted: string,
      addedFormatted: string,
      modifiedFormatted: string,
      removedFormatted: string,
      renamedFormatted: string,
      addedModifiedFormatted: string,
      addedModifiedRenamedFormatted: string
    switch (format) {
      case 'space-delimited':
        // If any of the filenames have a space in them, then fail the step.
        for (const file of all) {
          if (file.includes(' '))
            core.setFailed(
              `One of your files includes a space. Consider using a different output format or removing spaces from your filenames.`
            )
        }
        allFormatted = all.join(' ')
        addedFormatted = added.join(' ')
        modifiedFormatted = modified.join(' ')
        removedFormatted = removed.join(' ')
        renamedFormatted = renamed.join(' ')
        addedModifiedFormatted = addedModified.join(' ')
        addedModifiedRenamedFormatted = addedModifiedRenamed.join(' ')
        break
      case 'csv':
        allFormatted = all.join(',')
        addedFormatted = added.join(',')
        modifiedFormatted = modified.join(',')
        removedFormatted = removed.join(',')
        renamedFormatted = renamed.join(',')
        addedModifiedFormatted = addedModified.join(',')
        addedModifiedRenamedFormatted = addedModifiedRenamed.join(',')
        break
      case 'json':
        allFormatted = JSON.stringify(all)
        addedFormatted = JSON.stringify(added)
        modifiedFormatted = JSON.stringify(modified)
        removedFormatted = JSON.stringify(removed)
        renamedFormatted = JSON.stringify(renamed)
        addedModifiedFormatted = JSON.stringify(addedModified)
        addedModifiedRenamedFormatted = JSON.stringify(addedModifiedRenamed)
        break
    }

    // Log the output values.
    core.info(`All: ${allFormatted}`)
    core.info(`Added: ${addedFormatted}`)
    core.info(`Modified: ${modifiedFormatted}`)
    core.info(`Removed: ${removedFormatted}`)
    core.info(`Renamed: ${renamedFormatted}`)
    core.info(`Added or modified: ${addedModifiedFormatted}`)
    core.info(`Added, modified or renamed: ${addedModifiedRenamedFormatted}`)

    // Set step output context.
    const outputs = [
      ['all', allFormatted],
      ['added', addedFormatted],
      ['modified', modifiedFormatted],
      ['removed', removedFormatted],
      ['renamed', renamedFormatted],
      ['added_modified', addedModifiedFormatted],
      ['added_modified_renamed', addedModifiedRenamedFormatted]
    ]

    for (const [name, content] of outputs) {
      core.setOutput(name, content)
    }

    // Write to file
    if (writeFilesDir !== '') {
      // Create the folder if it doesn't exist
      const dir = path.join(process.env.GITHUB_WORKSPACE ?? '', writeFilesDir)
      await fs.access(dir).catch(async () => {
        await fs.mkdir(dir, {recursive: true})
      })

      const ext = format === 'space-delimited' ? 'txt' : format
      const writes = []
      for (const [name, content] of outputs) {
        const file = path.join(dir, `${name}.${ext}`)
        writes.push(fs.writeFile(file, content, {flag: 'w+', encoding: 'utf-8'}))
      }
      await Promise.all(writes)
      core.info(`Output written to ${dir}`)
    }

    // For backwards-compatibility
    core.setOutput('deleted', removedFormatted)
  } catch (error) {
    core.setFailed(error.message)
  }
}

run()
