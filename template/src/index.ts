export default class implements MW {
	/** auto inject */
	showDoc!: ShowDocFn
	chromeCookiesSecure!: ChromeCookiesSecure.Default
	openLoading!: (tips: string) => Function

	async generate(ctx: Ctx, next: NextFn) {
		// do somthing...
		await next()
		// do somthing...
		return ctx
	}

	async generateDiffCode(ctx: Ctx, next: NextFn) {
		// do somthing...
		await next()
		// do somthing...
		return ctx
	}

	dispose() { }
}