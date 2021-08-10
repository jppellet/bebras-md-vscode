import * as vscode from 'vscode'

import * as path from 'path'
import * as bmd from 'bebras-md'


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


function getFilenameAndVersionForLinting(doc: vscode.TextDocument): undefined | [string, string] {
	if (!isMarkdown(doc)) {
		return undefined
	}

	const uriPath = doc.uri.path
	const uriPathLastSlashPos = uriPath.lastIndexOf("/")
	let fullFilename: string
	if (uriPathLastSlashPos < 0) {
		fullFilename = uriPath
	} else {
		fullFilename = uriPath.slice(uriPathLastSlashPos + 1)
	}


	if (!fullFilename.endsWith(bmd.patterns.taskFileExtension)) {
		return undefined
	}
	const filename = fullFilename.slice(0, fullFilename.length - bmd.patterns.taskFileExtension.length)

	const prologueRange = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(2, 0))
	const prologue = doc.getText(prologueRange)
	let match
	if (!(match = bmd.patterns.prologue.exec(prologue))) {
		return undefined
	}
	const version = match.groups.version ?? "1.0"

	return [filename, version]
}

// Lints a Markdown document
function lint(doc: vscode.TextDocument) {

	const diags = [] as vscode.Diagnostic[]
	try {

		let basicInfo
		if (!(basicInfo = getFilenameAndVersionForLinting(doc))) {
			return
		}

		const [filename, version] = basicInfo
		const text = doc.getText()

		const outputs = bmd.check.check(text, filename, version)

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


	const extensionDisplayName = "bebras-md-vscode"

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


	context.subscriptions.push(
		vscode.commands.registerCommand('bebrasmd.exportHtml', makeExportHandler("html")),
		vscode.commands.registerCommand('bebrasmd.exportPdf', makeExportHandler("pdf")),
		vscode.commands.registerCommand('bebrasmd.exportTex', makeExportHandler("tex")),
	)


	return {
		extendMarkdownIt(md: any) {
			try {
				console.log("ACTIVATING BEBRAS MD PLUGIN")
				md = md.use(bmd.markdownitPlugin.plugin)
			} catch (e) {
				console.error(e)
			}
			return md
		},
	}

}

// this method is called when your extension is deactivated
export function deactivate() { }

function makeExportHandler(outputFormat: bmd.util.OutputFormat) {
	return async () => {
		if (!vscode.window.activeTextEditor) {
			return
		}

		const doc = vscode.window.activeTextEditor.document
		if (doc.uri.scheme !== "file") {
			return
		}

		const taskFile = doc.uri.fsPath
		const defaultOutUri = vscode.Uri.file(bmd.util.defaultOutputFile(taskFile, outputFormat))
		// const outUri = await vscode.window.showSaveDialog({ defaultUri: defaultOutUri })
		const outUri = defaultOutUri
		if (!outUri) {
			return
		}


		const outFile = outUri.fsPath
		const conversionFct = (bmd as any)["convert_" + outputFormat]["convertTask_" + outputFormat]

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
