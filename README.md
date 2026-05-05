# AI Gallery

AI Gallery 是一个 Obsidian 插件，基于 [obsidian-memories](https://github.com/DIMFLIX/obsidian-memories) 改造而来，用于在 Obsidian 中构建本地的 AI 生成图片浏览器。它能够在笔记中以自适应网格的形式展示本地文件夹中的图片、视频和音频文件，并提供便捷的导入、预览和管理功能。

## 截图展示

<table>
  <tr>
    <td align="center" width="33%">
      <img src="media/readme/Screenshot%202026-05-05%20at%2011.53.17.png" width="100%">
      <br>
      图 1：文章内瀑布流
    </td>
    <td align="center" width="33%">
      <img src="media/readme/macshot_2026-05-05_11-56-08.png" width="100%">
      <br>
      图 2：灯箱大图展示
    </td>
    <td align="center" width="33%">
      <img src="media/readme/Screenshot%202026-05-05%20at%2011.53.30.png" width="100%">
      <br>
      图 3：设置页面
    </td>
  </tr>
</table>

## 使用方法

在任意笔记中插入一个 `memories` 代码块，AI Gallery 就会自动扫描你指定的文件夹，将所有媒体文件以网格形式渲染在该代码块的位置。

## 设置

在 Obsidian 设置 → AI Gallery 中，你可以配置以下选项：

- **来源目录**：指定从哪个本地文件夹扫描待导入的图片，默认为系统 Downloads 目录。
- **默认导入文件夹**：指定图片导入到 vault 中的哪个文件夹，默认为 `pic`。如果代码块中写了 `paths`，则优先导入到代码块指定的路径。
- **灯箱模式 · 自动填充满窗口**：开启后，灯箱中的图片会拉伸填满整个窗口；关闭后图片以原始尺寸居中展示，周围使用暗色背景衬托。
- **导入规则**：你可以添加多条规则，每条规则包含一个文件名前缀和对应的显示标签。插件在扫描来源目录时，会将文件名以该前缀开头的文件归类到对应标签下，并自动将其移入目标文件夹。每条规则都可以单独启用或禁用。

## 代码块参数

在 ` ```memories` 代码块中，你可以通过以下参数自定义展示行为（每行一个参数）：

| 参数 | 说明 | 示例 |
|---|---|---|
| `paths` | 指定要扫描的文件夹路径（vault 内相对路径） | `paths: pic, screenshots` |
| `sortOrder` | 排序方式，支持 `date-desc` / `date-asc` / `name-asc` / `name-desc` | `sortOrder: date-desc` |
| `limit` | 最多展示的媒体文件数量 | `limit: 50` |
| `gridSize` | 网格卡片尺寸（px） | `gridSize: 220` |
| `displayType` | 展示模式，`full` 为完整信息栏模式 | `displayType: full` |


## 例子

```memories  
paths: pic/
sort: date-desc  
type: full 
size: 120  
lazy: true  
maxHeight: 80vh
```