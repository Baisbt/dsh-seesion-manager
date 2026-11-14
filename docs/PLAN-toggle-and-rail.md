# 方案：行勾选切换 · 状态列吃掉空档 · 表头分隔线

> 状态：**待审查（未改任何代码）**。三件事互不依赖，可分开落地、分开回滚。
> 代码位置：`client.js`。

---

## 1. 再次点击同一行 → 取消勾选

### 现状

`selectRow(id)`（client.js:1400）做的是「设焦点 + 加入勾选集合」，只加不减；
取消勾选只能点复选框本身（`toggleSelection`，client.js:1386）。

### 改法

```js
// 行点击 = 对「这一行自己」做勾选切换
const selectRow = (id) => {
  cursorRef.current = id                       // 记住键盘光标落点
  if (selection.has(id)) {
    setSelection(prev => { const next = new Set(prev); next.delete(id); return next })
    setActiveId(cur => (cur === id ? null : cur))   // 取消勾选 → 焦点环一并消失
  } else {
    setSelection(prev => { const next = new Set(prev); next.add(id); return next })
    setActiveId(id)
  }
}
```

要点：

- **只切换被点的那一行**，其它已勾选行保持不动（批量选择不会被误清）。
- 取消勾选时同时撤掉 1px 蓝色焦点环（`is-active`），避免「取消了还留个框」的观感；
  内部用 `cursorRef` 记住落点，下一次按 ↑/↓ 从这一行继续，不会跳回顶部。
- 复选框点击（`stopPropagation` + `toggleSelection`）行为不变。

### 顺带修掉一个既有问题

方向键现在也走 `selectRow`（client.js:1778），等于「一路按 ↓ 就一路勾上一串」。
改成：

| 操作 | 行为 |
| --- | --- |
| 单击行 | 勾选切换 + 焦点环跟随 |
| ↑ / ↓ | **只移动焦点环**，不改任何勾选（光标为 `null` 时从 `cursorRef` 续上） |
| 空格 | 切换「光标行」的勾选 |
| Enter / 双击 | 打开会话（不变） |

理由：方向键只用来定位，勾选是显式动作；否则滚一遍列表就把批量选择塞满了。

---

## 2. 状态列的右边缘贴到「操作」列，标签居中

### 现状（默认列全开）

```
[22 勾选][会话 320][工作区 132][创建 96][最后活动 96][大小 78][状态 82][  空 1fr  ][操作 76]
                                                              ↑ 状态贴左，右侧留一条 400px+ 的死空档
```

模板由 `gridTemplate`（client.js:1526）拼：在 `actions` 前插一条 `minmax(0, 1fr)`
纯空轨（`slackCell`），所以「状态」永远挨着「大小」，空档被画在状态右边。

### 改法：让最后一条数据列吃掉这条空轨

```
[22][会话 320][工作区 132][创建 96][最后活动 96][大小 78][ 状态 minmax(82px,1fr) ][操作 76]
                                                         ↑ 块右边缘 = 操作列左边缘（10px 间隔不变）
```

- 模板规则：**「可见列中、紧挨 `actions` 左边的那一列」= 弹性轨**（`minmax(该列宽度, 1fr)`），
  不再有独立的空轨。列顺序可拖，所以按「位置」算，不写死 `status`。
- 该列内容（表头「状态」+ 状态药丸）本来就居中 → 视觉落点正好是
  「大小右边缘 ↔ 操作左边缘」的中点，也就是你图里那条空档的正中。
- 删掉 `slackCell` 的插入（表头 + 行各一处，client.js:1738/1762）；
  只有「`actions` 左边没有任何数据列」这种退化情况才保留一条空轨。
- **列宽拖拽算式要同步改一个常数**：少一条轨就少一个 10px gap，
  `GAP * (order.length + 1)` → `GAP * order.length`（client.js:1573）。
  不改的话每列能拖的上限会少 10px（不崩，但错）。
- 拖拽算法其余部分不动：仍然是「先吃 `slack`，不够再向右邻居借」。
  差别只是那 400px 现在挂在「状态」这块底里，所以拖「大小」的右边界就能吃掉它。

### 连带的两个小决定

1. **状态列不再有拖拽手柄**：它的边界就是 操作 列，拖不动。
   规则定成「有手柄 ⇔ 拖得动」，把无意义的手柄去掉（现在是拖上去没反应）。
   它的存储宽度= 弹性轨的下限（默认 82px），拖左邻居时会被压到下限 56px 为止。
2. **状态被隐藏 / 被拖到别处**时，弹性轨自动落到新的「紧挨操作的那一列」，
   布局永远填满、不出现死空档。

---

## 3. 表头：hover 整个表头 → 显示全部列分隔线；操作列用底纹代替分隔线

### 现状

分隔线是 `.dsm-resizer::after`（client.js:442-447），只在**当前这一列表头 hover** 时显示，
所以一次只看得见一条，而且在最右边（操作列左）那条是拖不动的假线。

### 改法

把「线」从手柄上拆出来，挂到 `.dsm-th` 自己的 `::after`（手柄继续只负责点击热区）：

```css
.dsm-th:not(.is-actions):not(.is-flex)::after {
  content: ''; position: absolute; right: -5px; top: 50%;
  transform: translate(50%, -50%);
  width: 1px; height: 16px; border-radius: 1px;
  background: var(--dsw-alias-border-l3);
  opacity: 0; transition: opacity .12s ease;
}
/* 鼠标进入表头这个容器，全部列的线一起出现 */
.dsm-thead:hover .dsm-th:not(.is-actions):not(.is-flex)::after,
.dsm-thead:focus-within .dsm-th:not(.is-actions):not(.is-flex)::after { opacity: 1; }

/* 正要拖的那条边界 → 强调色 + 加粗，和自己的手柄对齐 */
.dsm-th:hover::after { background: var(--dsw-alias-state-business-primary); width: 2px; opacity: 1; }

@media (prefers-reduced-motion: reduce) { .dsm-th::after { transition: none } }
```

- 线落在 10px 间隔的正中（`right: -5px`），高度 16px 居中，不顶满表头上下边。
- 排除两类：`.is-actions`（操作列）和 `.is-flex`（弹性轨，即「状态」）。
  也就是 —— **分隔线只出现在「数据列 ⇄ 数据列」之间**；「状态 ⇄ 操作」这条界
  不出线，靠底纹区分，正好是你要的「最后一个字段与操作字段之间不显示间隔」。
- `:focus-within` 兜住键盘用户（表头里有全选复选框）。
- 原 `.dsm-resizer::after` 那条会消失（视觉重复），手柄热区 13×30 保留。

### 操作列换背景色 —— 两个档，请你挑

| | 方案 A（推荐） | 方案 B |
| --- | --- | --- |
| 范围 | 只有「操作」**表头**格 | 表头 + **整列**（每行的操作格） |
| 样式 | `background: var(--dsw-alias-bg-layer-2)` + `border-radius: 6px`，上下各借 5px 高 | 表头同上；行内那块用 `rgba(255,255,255,.03)` 叠一层 |
| 观感 | 表头右侧是一块「操作区」小色块，和左侧字段分开；行内干净，不打扰 hover/勾选底色 | 更像一条纵向操作轨，但会与 `row:hover` / `is-checked` 底色叠色，需要额外调透明度 |
| 风险 | 几乎无 | 行 hover / 勾选时那格颜色不一致，要单独压一遍 |

A 是「表头分流」，B 是「整列分流」。我按 A 备料，你要 B 我再补行的叠色规则。
底纹用 `bg-layer-2`；你刷新后如果觉得不够明显，一行换成 `bg-layer-3` 即可（我看不到实际渲染，颜色深浅要你定）。

---

## 影响面 / 边界

- 只改 `client.js` 的渲染层（`gridTemplate`、表头/行单元格生成、CSS、`selectRow`、方向键）。
- 不动：列配置面板、列显隐/排序/持久化、批量栏、删除/隐藏/恢复逻辑、左侧树、服务调用。
- 极窄窗口：弹性轨压到下限后表格横向溢出（与现在行为一致，`actions` 仍贴右）。
- 隐藏「状态」列、把「状态」拖到别的位置、把「操作」拖到中间 —— 都由「紧挨操作的那一列」规则覆盖。
- 语言：新增类名不含文案，无新词条。

## 自检（改完我会跑）

1. `node --check client.js`
2. `scripts/smoke.mjs`，断言需同步更新：
   - 模板 `22px 320px 132px 96px 96px 78px minmax(82px, 1fr) 76px`，轨道数 9 → **8**，每行子元素 9 → **8**；
   - 隐藏列的老配置用例：期望子元素 8 → **7**；
   - 新增：`status` 表头带 `is-flex` 且**无** resizer；`actions` 表头带 `is-actions` 且无 resizer；其余数据列 resizer 数 = 数据列数 − 1；
   - 新增：点行 → 勾上；再点同一行 → 勾掉且 `is-active` 消失（用现有 fake hooks 重渲染即可）；
   - 新增：按 ↓ 只改 `is-active`，勾选集合不变。
3. `plugin_manager` 关闭→开启 bundle 重载；刷新页面后由你确认观感。

## 审查清单（要你点头的三点）

- **D1** 操作列底纹：A（仅表头，推荐）还是 B（整列）？
- **D2** 取消勾选时焦点环一起消失（推荐），还是保留焦点环？
- **D3** 方向键只移动焦点、不改勾选（推荐），还是保持「移到哪就勾到哪」？

---

## 执行结果（2026-11-14）

已按你拍板的三条落地：**D1 = B（整列底纹）**、**D2 = 消失**、**D3 暂按「只移动焦点」**（一条开关，见下）。

改动（全在 `client.js` + `scripts/smoke.mjs`）：

1. `selectRow` 改为**只切换被点的那一行**：勾上 → 成为焦点；取消 → 焦点环一并清空。
   新增 `cursorRef`（`useRef`）记住落点，↑/↓ 从这一行续上而不是跳回顶部。
2. 方向键改走新的 `moveCursor`（只设焦点，不动勾选）；空格仍是切换勾选。
   若你最终想要「移到哪就勾到哪」，把 `moveCursor(nextId)` 换回 `selectRow(nextId)` 即可。
3. `gridTemplate` 改为「紧挨 actions 左边那一列 = `minmax(该列宽, 1fr)`」，删掉独立的空轨单元格；
   `flexId` 由实时列顺序推导，所以隐藏/拖动「状态」时弹性轨自动跟随。
4. `startResize` 的 gap 计数改为按轨道数推导（`tracks - 1`），不再写死 `order.length + 1`。
5. 表头单元格：`is-actions`（操作轨）、`is-flex`（弹性列）两个标记；可见列的 resizer 只在
   「有下一列且下一列不是 actions」时渲染 —— 有手柄 ⇔ 拖得动。
6. CSS：分隔线从拖拽手柄挪到 `.dsm-th::after`（`opacity` 由 `.dsm-thead:hover / :focus-within`
   统一点亮，正在拖的那条换强调色 + 2px）；`.dsm-th.is-actions` 与 `.dsm-row .dsm-actions`
   加底纹（`bg-layer-2` / `bg-layer-1`），负边距让两块底纹和行圆角落在同一条竖线上。

自检：`node --check` 通过；`scripts/smoke.mjs` 14 项全过（新增：轨道数 8 / 每行 8 格 /
7 个表头格 / 5 个拖拽手柄 / 两次点击取消勾选 / 方向键不改勾选）；
`impeccable detect --json client.js` → `[]`；bundle 重载 `application: applied`。
