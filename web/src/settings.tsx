import { Bold, Check, ChevronLeft, FileUp, KeyRound, Minus, Plus, Sparkles, TextCursor, Trash2, Type } from 'lucide-react'
import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { ButtonGroup, ButtonGroupText } from '@/components/ui/button-group'
import { Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import { Item, ItemActions, ItemContent, ItemGroup, ItemMedia, ItemSeparator, ItemTitle } from '@/components/ui/item'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { FONTS, type FontKey } from './fonts'
import { fingerprint } from './keys'
import { applyLookToAllSessions, setFontFamilyForAllSessions, setFontSizeForAllSessions } from './session'
import {
	allThemes,
	currentTheme,
	customThemes,
	FONT_MAX,
	FONT_MIN,
	fontKey,
	fontSize,
	saveCustomThemes,
	setTermPrefs,
	setThemeId,
	termPrefs,
	type CursorStyle,
	type TermPrefs,
} from './store'
import { applyTheme, parseTheme, type Theme } from './themes'

function Section(props: { title: string; children: ReactNode[] | ReactNode }) {
	const rows = Array.isArray(props.children) ? props.children.flat() : [props.children]
	return (
		<section className="px-4">
			<h2 className="mt-5 mb-2 px-1 text-[13px] font-medium text-muted-foreground">{props.title}</h2>
			<ItemGroup className="overflow-hidden rounded-xl bg-card">
				{rows.map((row, i) => (
					<Fragment key={i}>
						{i > 0 && <ItemSeparator className="my-0" />}
						{row}
					</Fragment>
				))}
			</ItemGroup>
		</section>
	)
}

function Swatch({ theme }: { theme: Theme }) {
	return (
		<span className="flex h-8 w-16 shrink-0 items-center gap-0.5 rounded-md border px-1.5" style={{ background: theme.background, color: theme.foreground }}>
			<span className="text-[11px] font-semibold">Aa</span>
			{[1, 2, 3, 4, 5].map(i => (
				<span key={i} className="size-1.5 rounded-full" style={{ background: theme.ansi[i + 8] }} />
			))}
		</span>
	)
}

function ImportTheme(props: { open: boolean; onOpenChange: (open: boolean) => void; onImported: (t: Theme) => void }) {
	const [text, setText] = useState('')
	const [error, setError] = useState('')
	const submit = () => {
		try {
			const t = parseTheme(text)
			saveCustomThemes([...customThemes().filter(x => x.id !== t.id), t])
			setText('')
			setError('')
			props.onImported(t)
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e))
		}
	}
	return (
		<Drawer open={props.open} onOpenChange={props.onOpenChange}>
			<DrawerContent>
				<DrawerHeader className="text-left">
					<DrawerTitle>导入主题</DrawerTitle>
					<DrawerDescription>
						粘贴 JSON：{'{'} "v": 1, "name", "mode": "dark" 或 "light", "colors": {'{'} "background", "foreground", "black"…"brightWhite" {'}'} {'}'}
					</DrawerDescription>
				</DrawerHeader>
				<div className="px-4">
					<Textarea
						value={text}
						onChange={e => setText(e.currentTarget.value)}
						rows={8}
						className="font-mono text-[13px]"
						autoCapitalize="off"
						autoCorrect="off"
						spellCheck={false}
						placeholder='{"v":1,"name":"我的主题","mode":"dark","colors":{"background":"#1d1f21","foreground":"#c5c8c6"}}'
					/>
					{error && <p className="mt-2 text-sm text-destructive">{error}</p>}
				</div>
				<DrawerFooter>
					<Button onClick={submit} disabled={!text.trim()}>
						导入
					</Button>
					<DrawerClose asChild>
						<Button variant="secondary">取消</Button>
					</DrawerClose>
				</DrawerFooter>
			</DrawerContent>
		</Drawer>
	)
}

export function SettingsPage(props: { onBack: () => void }) {
	const [theme, setTheme] = useState(() => currentTheme().id)
	const [themes, setThemes] = useState(allThemes)
	const [importing, setImporting] = useState(false)
	const [prefs, setPrefs] = useState(termPrefs)
	const [font, setFont] = useState(fontKey)
	const [size, setSize] = useState(fontSize)
	const [fp, setFp] = useState('')
	useEffect(() => {
		fingerprint().then(setFp, () => setFp(''))
	}, [])
	const pickTheme = (t: Theme) => {
		setThemeId(t.id)
		setTheme(t.id)
		applyTheme(t)
		applyLookToAllSessions()
	}
	const removeTheme = (t: Theme) => {
		saveCustomThemes(customThemes().filter(x => x.id !== t.id))
		setThemes(allThemes())
		if (theme === t.id) pickTheme(allThemes()[0])
	}
	const updatePrefs = (p: Partial<TermPrefs>) => {
		const next = { ...prefs, ...p }
		setPrefs(next)
		setTermPrefs(next)
		applyLookToAllSessions()
	}
	const resize = (n: number) => {
		const next = Math.min(FONT_MAX, Math.max(FONT_MIN, n))
		setSize(next)
		setFontSizeForAllSessions(next)
	}

	return (
		<main id="settings" className="pb-10">
			<header className="topbar">
				<Button variant="secondary" size="icon" className="rounded-full" aria-label="返回" onClick={props.onBack}>
					<ChevronLeft className="size-5" />
				</Button>
				<h1>设置</h1>
				<span />
			</header>

			<Section title="主题">
				{themes.map(t => (
					<Item key={t.id} size="sm" asChild>
						<button type="button" data-theme={t.id} aria-pressed={theme === t.id} className="w-full text-left active:bg-accent" onClick={() => pickTheme(t)}>
							<ItemMedia>
								<Swatch theme={t} />
							</ItemMedia>
							<ItemContent>
								<ItemTitle className="text-base font-normal">{t.name}</ItemTitle>
							</ItemContent>
							<ItemActions>
								{theme === t.id && <Check className="size-5 text-ok" />}
								{t.custom && (
									<Button
										asChild
										variant="ghost"
										size="icon-sm"
										aria-label={`删除 ${t.name}`}
										onClick={e => {
											e.stopPropagation()
											removeTheme(t)
										}}
									>
										<span>
											<Trash2 />
										</span>
									</Button>
								)}
							</ItemActions>
						</button>
					</Item>
				))}
				<Item size="sm" asChild>
					<button type="button" className="w-full text-left active:bg-accent" onClick={() => setImporting(true)}>
						<ItemMedia>
							<FileUp className="size-5 text-muted-foreground" />
						</ItemMedia>
						<ItemContent>
							<ItemTitle className="text-base font-normal">导入主题…</ItemTitle>
						</ItemContent>
					</button>
				</Item>
			</Section>
			<ImportTheme
				open={importing}
				onOpenChange={setImporting}
				onImported={t => {
					setImporting(false)
					setThemes(allThemes())
					pickTheme(t)
				}}
			/>

			<Section title="光标">
				<Item size="sm">
					<ItemMedia>
						<TextCursor className="size-5 text-muted-foreground" />
					</ItemMedia>
					<ItemContent>
						<ItemTitle className="text-base font-normal">样式</ItemTitle>
					</ItemContent>
					<ItemActions>
						<ToggleGroup
							type="single"
							variant="outline"
							value={prefs.cursorStyle}
							onValueChange={v => v && updatePrefs({ cursorStyle: v as CursorStyle })}
						>
							<ToggleGroupItem value="block">方块</ToggleGroupItem>
							<ToggleGroupItem value="underline">下划线</ToggleGroupItem>
							<ToggleGroupItem value="bar">竖线</ToggleGroupItem>
						</ToggleGroup>
					</ItemActions>
				</Item>
				<Item size="sm">
					<ItemMedia>
						<Sparkles className="size-5 text-muted-foreground" />
					</ItemMedia>
					<ItemContent>
						<ItemTitle className="text-base font-normal">闪烁</ItemTitle>
					</ItemContent>
					<ItemActions>
						<Switch aria-label="光标闪烁" checked={prefs.cursorBlink} onCheckedChange={v => updatePrefs({ cursorBlink: v })} />
					</ItemActions>
				</Item>
			</Section>

			<Section title="终端文字">
				<Item size="sm">
					<ItemMedia>
						<Type className="size-5 text-muted-foreground" />
					</ItemMedia>
					<ItemContent>
						<ItemTitle className="text-base font-normal">字号</ItemTitle>
					</ItemContent>
					<ItemActions>
						<ButtonGroup>
							<Button variant="secondary" size="icon" aria-label="小一号" disabled={size <= FONT_MIN} onClick={() => resize(size - 1)}>
								<Minus />
							</Button>
							<ButtonGroupText data-font-size className="min-w-10 justify-center border-0 bg-secondary tabular-nums">
								{size}
							</ButtonGroupText>
							<Button variant="secondary" size="icon" aria-label="大一号" disabled={size >= FONT_MAX} onClick={() => resize(size + 1)}>
								<Plus />
							</Button>
						</ButtonGroup>
					</ItemActions>
				</Item>
				<Item size="sm">
					<ItemMedia>
						<Bold className="size-5 text-muted-foreground" />
					</ItemMedia>
					<ItemContent>
						<ItemTitle className="text-base font-normal">粗体用亮色</ItemTitle>
					</ItemContent>
					<ItemActions>
						<Switch aria-label="粗体用亮色" checked={prefs.boldBright} onCheckedChange={v => updatePrefs({ boldBright: v })} />
					</ItemActions>
				</Item>
			</Section>

			<Section title="字体">
				{(Object.keys(FONTS) as FontKey[]).map(k => (
					<Item key={k} size="sm" asChild>
						<button
							type="button"
							data-font={k}
							aria-pressed={font === k}
							className="w-full text-left active:bg-accent"
							onClick={() => {
								setFont(k)
								setFontFamilyForAllSessions(k)
							}}
						>
							<ItemContent>
								<ItemTitle className="text-base font-normal">{FONTS[k].label}</ItemTitle>
							</ItemContent>
							{font === k && <Check className="size-5 text-ok" />}
						</button>
					</Item>
				))}
			</Section>

			<Section title="这台手机">
				<Item size="sm">
					<ItemMedia>
						<KeyRound className="size-5 text-muted-foreground" />
					</ItemMedia>
					<ItemContent>
						<ItemTitle className="text-base font-normal">密钥指纹</ItemTitle>
					</ItemContent>
					<ItemActions className="font-mono text-muted-foreground">{fp}</ItemActions>
				</Item>
			</Section>
		</main>
	)
}
