import * as vscode from 'vscode'

import * as path from 'path'
import * as fs from 'fs'
import * as bebras from 'bebras'
import * as minimatch from "minimatch"

// maps containing folder name to list of author completions
const AuthorCompletionCache = new Map<string, string[]>()

async function getAuthorCompletions(folderPath: string): Promise<string[]> {
	let completions = AuthorCompletionCache.get(folderPath)
	if (!bebras.util.isUndefined(completions)) {
		// TODO check if file not newer
		return completions
	}
	const completionFile = path.join(folderPath, "authors_completion.txt")
	completions = []
	if (fs.existsSync(completionFile)) {
		const lines = await fs.promises.readFile(completionFile, "utf8")
		completions = lines.split('\n').filter(l => l.length > 0)
	}
	AuthorCompletionCache.set(folderPath, completions)
	return completions
}

// Suppresses a pending lint for the specified document
function suppressLint(document: vscode.TextDocument | null) {
	if (throttle.timeout && (document === throttle.document)) {
		clearTimeout(throttle.timeout)
		throttle.document = null
		throttle.timeout = null
	}
}

// Requests a lint of the specified document
function requestLint(document: vscode.TextDocument) {
	suppressLint(document)
	throttle.document = document
	throttle.timeout = setTimeout(() => {
		// Do not use throttle.document in this function; it may have changed
		lint(document)
		suppressLint(document)
	}, throttleDuration)
}

function isMarkdown(doc: vscode.TextDocument) {
	return doc.languageId === "markdown"
}


function getFilenameAndVersionForLinting(doc: vscode.TextDocument): undefined | { filePath: string, version: string } {
	if (!isMarkdown(doc)) {
		return undefined
	}

	const filePath = doc.uri.fsPath
	if (!filePath.endsWith(bebras.patterns.taskFileExtension)) {
		return undefined
	}

	const prologueRange = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(2, 0))
	const prologue = doc.getText(prologueRange)
	let match
	if (!(match = bebras.patterns.prologue.exec(prologue))) {
		return undefined
	}
	const version = match.groups.version ?? "1.0"

	return { filePath, version }
}

// Lints a Markdown document
function lint(doc: vscode.TextDocument) {

	const diags = [] as vscode.Diagnostic[]
	try {

		let basicInfo
		if (!(basicInfo = getFilenameAndVersionForLinting(doc))) {
			return
		}

		const { filePath, version } = basicInfo
		const text = doc.getText()

		const outputs = bebras.check.check(text, filePath, version)

		for (const o of outputs) {
			let sev: vscode.DiagnosticSeverity
			switch (o.type) {
				case "error":
					sev = vscode.DiagnosticSeverity.Error
					break
				case "warn":
				default:
					sev = vscode.DiagnosticSeverity.Warning
					break
			};

			const diag = new vscode.Diagnostic(new vscode.Range(doc.positionAt(o.start), doc.positionAt(o.end)), o.msg, sev)
			diags.push(diag)
		}


	} finally {
		diagnosticCollection.set(doc.uri, diags)
	}

}

const throttle = {
	"document": null as (null | vscode.TextDocument),
	"timeout": null as (null | NodeJS.Timeout),
}
const throttleDuration = 500

let diagnosticCollection: vscode.DiagnosticCollection

function didChangeVisibleTextEditors(textEditors: vscode.TextEditor[]) {
	textEditors.forEach((textEditor) => lint(textEditor.document))
}

// Handles the onDidChangeTextDocument event
function didChangeTextDocument(change: vscode.TextDocumentChangeEvent) {
	const doc = change.document
	if (isMarkdown(doc)) {
		requestLint(doc)
	}
}

// Handles the onDidSaveTextDocument event
function didSaveTextDocument(doc: vscode.TextDocument) {
	if (isMarkdown(doc)) {
		lint(doc)
		suppressLint(doc)
	}
}

// Handles the onDidCloseTextDocument event
function didCloseTextDocument(document: vscode.TextDocument) {
	suppressLint(document)
	diagnosticCollection.delete(document.uri)
}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {


	const extensionDisplayName = "bebras-vscode"

	// Create OutputChannel
	const outputChannel = vscode.window.createOutputChannel(extensionDisplayName)
	context.subscriptions.push(outputChannel)

	// Hook up to workspace events
	context.subscriptions.push(
		vscode.window.onDidChangeVisibleTextEditors(didChangeVisibleTextEditors),
		vscode.workspace.onDidChangeTextDocument(didChangeTextDocument),
		vscode.workspace.onDidSaveTextDocument(didSaveTextDocument),
		vscode.workspace.onDidCloseTextDocument(didCloseTextDocument),
	)

	// Create DiagnosticCollection
	diagnosticCollection = vscode.languages.createDiagnosticCollection(extensionDisplayName)
	context.subscriptions.push(diagnosticCollection)

	// Cancel any pending operations during deactivation
	context.subscriptions.push({
		"dispose": () => suppressLint(throttle.document),
	})

	// Request (deferred) lint of active document
	if (vscode.window.activeTextEditor) {
		requestLint(vscode.window.activeTextEditor.document)
	}

	function loggingErrors<T>(promiseFct: () => Promise<void>): () => Promise<void> {
		return () => {
			const p = promiseFct()
			return p.catch(err => console.log(err))
		}
	}

	const validRolesStr = bebras.patterns.validRoles.join(",")

	const authorCompletion = {
		async provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position, cancel: vscode.CancellationToken, ctx: vscode.CompletionContext) {
			if (!isTask(doc)) {
				console.log("not a task")
				return []
			}

			const LinePrefix = "  - "
			const line = doc.lineAt(pos)
			console.log(`Line: '${line.text}'`)
			const match = /^\s*\-?\s*(?<filter>.*?)(?:\s+\(.*)?$/.exec(line.text)
			if (!match) {
				console.log("no match")
				return []
			}

			const filter = match.groups?.filter?.toLowerCase()
			console.log(`filter: '${filter}'`)

			const authors = await getAuthorCompletions(path.dirname(path.dirname(doc.uri.fsPath)))
			const completionAuthors = !filter
				? authors
				: authors.filter(auth => auth.toLowerCase().startsWith(filter))

			console.log(completionAuthors)

			const completions = completionAuthors.map(authorString => {
				const item = new vscode.CompletionItem(authorString)
				item.insertText = new vscode.SnippetString(LinePrefix + authorString + ` (\${0:role})`)
				item.keepWhitespace = true
				item.kind = vscode.CompletionItemKind.User
				item.range = line.range
				return item
			})

			console.log(`returning ${completions.length} completions`)

			return completions
		},
	}

	context.subscriptions.push(
		vscode.commands.registerCommand('bebrasmd.exportHtml', loggingErrors(makeExportHandler("html"))),
		vscode.commands.registerCommand('bebrasmd.exportPdf', loggingErrors(makeExportHandler("pdf"))),
		vscode.commands.registerCommand('bebrasmd.exportTex', loggingErrors(makeExportHandler("tex"))),
		vscode.commands.registerCommand('bebrasmd.addMissingSupportFileEntries', loggingErrors(addMissingSupportFileEntries)),
		vscode.languages.registerCompletionItemProvider({ scheme: 'file', language: 'markdown', pattern: '**/*' + bebras.patterns.taskFileExtension }, authorCompletion),
	)

	return {
		extendMarkdownIt(md: any) {
			try {
				console.log("ACTIVATING BEBRAS MD PLUGIN")
				md = md.use(bebras.markdownitPlugin.plugin)
			} catch (e) {
				console.error(e)
			}
			return md
		},
	}

}

// this method is called when your extension is deactivated
export function deactivate() { }

function isTask(doc: vscode.TextDocument): boolean {
	const uri = doc.uri
	if (uri.scheme !== "file") {
		return false
	}

	const fileName = path.basename(uri.fsPath)
	if (!fileName.endsWith(bebras.patterns.taskFileExtension)) {
		return false
	}

	return true
}

async function addMissingSupportFileEntries(): Promise<void> {
	const editor = vscode.window.activeTextEditor
	if (!editor) {
		return
	}

	const doc = editor.document
	if (!isTask(doc)) {
		return
	}

	const taskFile = doc.uri.fsPath
	const taskFolder = path.dirname(taskFile)

	const definedFilePatterns = findDefinedSupportFiles(doc)

	function findDefinedSupportFiles(doc: vscode.TextDocument): string[] {
		const text = doc.getText()
		const loadResult = bebras.check.loadRawMetadata(text)
		if (bebras.util.isUndefined(loadResult)) {
			return []
		}
		const metadata: Partial<bebras.util.TaskMetadata> = loadResult[3]
		const supportFiles = metadata.support_files
		if (bebras.util.isUndefined(supportFiles) || !bebras.util.isArray(supportFiles)) {
			return []
		}
		const found: string[] = []
		for (const supportFile of supportFiles) {
			let match
			if (match = bebras.patterns.supportFile.exec(supportFile)) {
				found.push(match.groups.file_pattern)
			}
		}
		return found
	}

	const names: string[] = []

	for (const folderName of ["graphics", "interactive"]) {
		const folder = path.join(taskFolder, folderName)
		if (fs.existsSync(folder)) {
			const localNames = await fs.promises.readdir(folder)
			for (const localName of localNames) {
				let matchedBy: string | undefined = undefined
				for (const pattern of definedFilePatterns) {
					if (minimatch(localName, pattern)) {
						matchedBy = pattern
						break
					}
				}
				if (bebras.util.isUndefined(matchedBy)) {
					names.push(localName)
				}
			}
		}
	}

	const LinePrefix = "  - "
	const LineSuffix = " by ..."
	const lines = names.map(n => LinePrefix + n + LineSuffix).join("\n")
	editor.edit(editBuilder => {
		let sel = editor.selection
		let line
		let target
		if (sel.isEmpty && (line = doc.lineAt(sel.active)).isEmptyOrWhitespace) {
			target = line.range
		} else {
			target = sel
		}

		editBuilder.replace(target, lines)
	})
}

function makeExportHandler(outputFormat: bebras.util.OutputFormat) {
	return async () => {
		const editor = vscode.window.activeTextEditor
		if (!editor) {
			return
		}

		const doc = editor.document
		if (!isTask(doc)) {
			return
		}

		const taskFile = doc.uri.fsPath
		const defaultOutUri = vscode.Uri.file(bebras.util.defaultOutputFile(taskFile, outputFormat))
		// const outUri = await vscode.window.showSaveDialog({ defaultUri: defaultOutUri })
		const outUri = defaultOutUri
		if (!outUri) {
			return
		}


		const outFile = outUri.fsPath
		const conversionFct = (bebras as any)["convert_" + outputFormat]["convertTask_" + outputFormat]

		vscode.window.withProgress({ location: vscode.ProgressLocation.Window }, async (progress) => {
			progress.report({
				message: `Converting task to ` + outputFormat,
			})
			try {
				const writtenPath = await conversionFct(taskFile, outFile)
				vscode.window.setStatusBarMessage("Wrote " + formatRelativePathFor(outFile, taskFile), 2000)
			} catch (err) {
				console.error(err)
			}
		})
	}
}

function formatRelativePathFor(outFile: string, taskFile: string) {
	const folder = path.dirname(taskFile) + '/'
	if (outFile.startsWith(folder)) {
		outFile = path.join(path.basename(folder), outFile.substring(folder.length))
	}
	return outFile
}
