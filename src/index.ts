import axios from 'axios'
import JsonToTS from 'json-to-ts'
import { camelizeKeys } from 'humps'
import { AbortController } from 'node-abort-controller'

interface RequestRecordMap {
	[key: string]: AbortController
}

export default class implements MW {
	/** auto inject */
	showDoc!: ShowDocFn
	chromeCookiesSecure!: ChromeCookiesSecure.Default
	openLoading!: (tips: string) => Function

	/** 请求中的取消方法记录 */
	fetchingControllerRecord: RequestRecordMap = {}

	async generate(ctx: Ctx, next: NextFn) {
		// 已经发了请求，取消已发出去的请求，再次发送
		if (this.fetchingControllerRecord[ctx.config.url]) {
			this.fetchingControllerRecord[ctx.config.url].abort()
		}

		const controller = new AbortController()

		this.fetchingControllerRecord[ctx.config.url] = controller

		ctx.newCode = await this.fetch(ctx)

		await next()

		return ctx
	}

	generateDiffCode(ctx: Ctx, next: NextFn) {
		if (ctx.existCode && ctx.newCode && ctx.diffCode === null) {
			const oldCodeArr = ctx.existCode.trim().split(/(\n|\r\n)/)
			const newCodeArr = ctx.newCode.trim().split(/(\n|\r\n)/)

			const [oldDiffArr, oldMap] = this.wipeEmptyLineAndGenIndexMap(this.wipeNotNeedDiffChars(oldCodeArr))
			const [newDiffArr, newMap] = this.wipeEmptyLineAndGenIndexMap(this.wipeNotNeedDiffChars(newCodeArr))

			const diffCodeArr = ctx.diffFn({
				old_arr: oldDiffArr, new_arr: newDiffArr
			})

			if (diffCodeArr.length === 1) {
				const [action] = diffCodeArr[0]
				if (action === "EQ") {
					// 相等
					return next()
				} else {
					// 全部新增、全部删除
					ctx.diffCode = ctx.newCode.trim()
					return next()
				}
			}

			// 获取原始的字符串
			const getOrgValue = (arr: string[], map: Record<number, number>, start: number, end: number) => {
				// 第一个从 0 开始
				const realStart = start === 0 ? 0 : map[start]
				// 最后一个选最后
				const realEnd = map[end + 1] ? map[end] : arr.length - 1

				// 拼接不需要 diff 的字符
				let ignoreValue = ''
				// 说明中间有忽略的字符行
				if (start !== 0 && realStart - map[start - 1] > 0) {
					ignoreValue = arr.slice(map[start - 1] + 1, realStart).join('')
				}

				return [ignoreValue, arr.slice(realStart, realEnd + 1).join('')] as [string, string]
			}

			ctx.diffCode = diffCodeArr.reduce((txt, [action, start, end], i) => {
				// 默认取原文本
				let [ignore, value] = getOrgValue(oldCodeArr, oldMap, start, end)
				value = ignore + value
				if (action === 'ADD') {
					// 新增取新文本
					;[ignore, value] = getOrgValue(newCodeArr, newMap, start, end)
					value = ignore + value
				} else if (action === 'RM') {
					const next = diffCodeArr[i + 1]
					// 删除跟着添加，说明是修改，加 diff
					if (next && next[0] === 'ADD') {
						const [ignoreOldValue, oldValue] = getOrgValue(oldCodeArr, oldMap, start, end)
						const [, newValue] = getOrgValue(newCodeArr, newMap, start, end)
						value = `${ignoreOldValue}<<<<<<<\n${oldValue}\n=======\n${newValue}\n>>>>>>>`
						for (let i = start; i <= end; i++) {
							newCodeArr[newMap[i]] = ''
						}
					} else {
						// 说明是本地添加的，不改动
					}
				}
				return txt + value
			}, '')
			return next()
		}
		return next()
	}

	dispose() {
		Object.values(this.fetchingControllerRecord).forEach(c => c.abort())
	}

	private async fetch({ config }: Ctx) {
		const { url, method = 'get' as any, json, cookie } = config

		let promise: Promise<any>

		if (json) {
			promise = Promise.resolve({ data: json })
		} else {
			let Cookie = ''
			if (Boolean(cookie)) {
				try {
					Cookie = await this.chromeCookiesSecure.getCookiesPromised(url, 'header')
				} catch (e) {
					throw new Error(`${url}: chromeCookiesSecure 获取 cookie 失败 \n${e}`)
				}
			}
			promise = axios({
				url,
				method,
				signal: this.fetchingControllerRecord[url].signal,
				headers: {
					Cookie,
					'User-Agent': 'VSCode Ext: FetchTsType/base-mw/fetch'
				}
			})
		}

		let res
		try {
			res = await promise
		} catch (err: any) {
			if (err?.message === 'canceled') {
				return null
			}

			throw new Error(
				`
/*
|-------------------------------|
|           请求失败             |
|------------------------------|
*/

/*********          响应体            **********/

const response = ${err?.response ? JSON.stringify({ ...err.response, request: null }, null, 2) : err}

`)
		} finally {
			Reflect.deleteProperty(this.fetchingControllerRecord, url)
		}

		try {
			return this.genTsType(config, res.data)
		} catch (transferErrMsg) {
			throw new Error(
				`
/*
|-------------------------------|
|           转换失败             |
|------------------------------|
*/

/*********         错误消息            **********/

${transferErrMsg}

/*********          响应体            **********/

const response = ${JSON.stringify({ ...res, request: null }, null, 2)}

`)
		}
	}

	/** 根据响应生成 TS 类型 */
	private genTsType(config: Config, data: any) {
		data = camelizeKeys(data)
		let type = JsonToTS(data)
			.join('\nexport ')
			.replace(/\n|;/gms, match => {
				if (match === '\n') {
					return '\n\t'
				} else {
					return ''
				}
			})

		return `export namespace ${config.namespace} {\n\texport ${type}\n}\n`
	}

	/** 去除不需要 diff 的字符 */
	private wipeNotNeedDiffChars(arr: string[]) {
		// 没有关闭的块级注释标识
		let notCloseBlockComment = false

		const wipe = (line: string) => {
			const blockCommentBegin = '/*'
			const blockCommentEnd = '*/'

			if (notCloseBlockComment) {
				/**
				 * 块级注释没有关闭，当前行也没有关闭，替换为空
				 * @example
				 * /*
				 *  123 <-- this
				 */
				if (line.indexOf(blockCommentEnd) === -1) {
					return ''
				}
				notCloseBlockComment = false
				// 关闭文本后面可能还有正常字符，清除注释文本，交给后续处理
				line = line.replace(/.*?\*\//g, '')
			}

			const i = line.indexOf(blockCommentBegin)
			// 有块级注释开始文本，替换注释为空，交给后续处理
			if (i !== -1) {
				// 块级注释没有同行结束
				if (line.substring(i + blockCommentBegin.length).indexOf(blockCommentEnd) === -1) {
					notCloseBlockComment = true
					line = line.replace(/\/\*.*/g, '')
				} else {
					line = line.replace(/\/\*.*?\*\//g, '')
				}
			}

			// 去除空字符、分号、单行注释
			return line.replace(/\s|;|(\/\/.*)/g, '')
		}

		return arr.map(wipe)
	}

	/** 去除空行，建立与原始数组的索引映射 */
	private wipeEmptyLineAndGenIndexMap(arr: string[]) {
		// [没有空行的数组，{ 去除空行的索引：原始数组的索引 }]
		return arr.reduce(([emptyArr, map], line, orgIndex) => {
			if (line !== '') {
				emptyArr.push(line)
				map[emptyArr.length - 1] = orgIndex
			}
			return [emptyArr, map] as any
		}, [[], {}] as [string[], Record<number, number>])
	}
}