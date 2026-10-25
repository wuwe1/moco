import { Check, ChevronLeft, KeyRound, Minus, Plus, Type } from 'lucide-react'
import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { ButtonGroup, ButtonGroupText } from '@/components/ui/button-group'
import { Item, ItemActions, ItemContent, ItemGroup, ItemMedia, ItemSeparator, ItemTitle } from '@/components/ui/item'
import { FONTS, type FontKey } from './fonts'
import { fingerprint } from './keys'
import { setFontFamilyForAllSessions, setFontSizeForAllSessions } from './session'
import { FONT_MAX, FONT_MIN, fontKey, fontSize } from './store'

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

export function SettingsPage(props: { onBack: () => void }) {
	const [font, setFont] = useState(fontKey)
	const [size, setSize] = useState(fontSize)
	const [fp, setFp] = useState('')
	useEffect(() => {
		fingerprint().then(setFp, () => setFp(''))
	}, [])
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
