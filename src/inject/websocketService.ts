// WebSocket服务相关接口
interface SubtitleRequest {
  type: 'GET_SUBTITLE'
  videoUrl: string
  requestId: string
}

interface SubtitleResponse {
  type: 'SUBTITLE_RESULT'
  requestId: string
  data?: {
    title: string
    author: string
    url: string
    ctime: number
    subtitles: TranscriptItem[]
  }
  error?: string
}

interface TranscriptItem {
  from: number
  to: number
  content: string
}

/**
 * Inject上下文的WebSocket服务
 * 在页面上下文中运行，可以访问bilibili.com的cookies
 */
export class InjectWebSocketService {
  private ws: WebSocket | null = null
  private reconnectTimer: number | null = null
  private readonly serverUrl: string = 'ws://localhost:8080'
  private readonly reconnectInterval: number = 10000
  private isConnecting: boolean = false

  constructor() {
    this.log('WebSocket服务初始化 (inject context)')
    this.start()
  }

  private start(): void {
    this.log('启动WebSocket服务')
    this.connect()
  }

  private connect(): void {
    if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) {
      return
    }

    this.isConnecting = true
    this.log('尝试连接WebSocket服务器', { url: this.serverUrl })

    try {
      this.ws = new WebSocket(this.serverUrl)

      this.ws.onopen = () => {
        this.isConnecting = false
        this.log('WebSocket连接成功')

        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer)
          this.reconnectTimer = null
        }
      }

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data)
      }

      this.ws.onclose = (event) => {
        this.isConnecting = false
        this.log('WebSocket连接关闭', { code: event.code, reason: event.reason })
        this.scheduleReconnect()
      }

      this.ws.onerror = (error) => {
        this.isConnecting = false
        this.log('WebSocket连接错误', { error: String(error) })
        this.scheduleReconnect()
      }
    } catch (error) {
      this.isConnecting = false
      this.log('WebSocket连接异常', { error: String(error) })
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return
    }

    this.log(`${this.reconnectInterval / 1000}秒后尝试重连...`)

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, this.reconnectInterval)
  }

  private handleMessage(data: string): void {
    try {
      const message: SubtitleRequest = JSON.parse(data)
      this.log('收到消息', { message })

      if (message.type === 'GET_SUBTITLE') {
        this.handleSubtitleRequest(message)
      } else {
        this.log('未知消息类型', { type: message.type })
      }
    } catch (error) {
      this.log('消息解析失败', { error: String(error), data })
    }
  }

  private async handleSubtitleRequest(request: SubtitleRequest): Promise<void> {
    this.log('开始处理字幕请求', { videoUrl: request.videoUrl })

    try {
      // 从URL中提取BV号
      const bvid = this.extractBVID(request.videoUrl)
      this.log('提取BV号成功', { bvid })

      // 获取视频信息 - 在inject context中，可以访问bilibili.com的cookies
      const videoInfo = await this.getVideoInfo(bvid)
      this.log('获取视频信息成功', { title: videoInfo.title, aid: videoInfo.aid })

      // 获取字幕列表（使用第一个分P）
      const pageInfo = videoInfo.pages[0]
      const subtitleList = await this.getSubtitleList(videoInfo.aid, pageInfo.cid)

      if (!subtitleList || subtitleList.length === 0) {
        throw new Error('该视频没有可用的字幕')
      }

      this.log('获取字幕列表成功', { count: subtitleList.length })

      // 下载第一个字幕文件（通常是自动生成的中文字幕）
      const subtitleData = await this.downloadSubtitle(subtitleList[0])
      this.log('字幕下载成功', { itemCount: subtitleData.body?.length || 0 })

      // 构造响应数据
      const response: SubtitleResponse = {
        type: 'SUBTITLE_RESULT',
        requestId: request.requestId,
        data: {
          title: videoInfo.title,
          author: videoInfo.owner?.name || '未知作者',
          url: request.videoUrl,
          ctime: videoInfo.ctime,
          subtitles: subtitleData.body || []
        }
      }

      this.sendResponse(response)
      this.log('字幕数据发送成功', { requestId: request.requestId })
    } catch (error) {
      this.log('处理字幕请求失败', { error: String(error), videoUrl: request.videoUrl })

      const errorResponse: SubtitleResponse = {
        type: 'SUBTITLE_RESULT',
        requestId: request.requestId,
        error: String(error)
      }

      this.sendResponse(errorResponse)
    }
  }

  private extractBVID(url: string): string {
    const bvMatch = url.match(/\/video\/(BV\w+)/)
    if (!bvMatch) {
      throw new Error('无法从URL中提取BV号，请确保URL格式正确')
    }
    return bvMatch[1]
  }

  private async getVideoInfo(bvid: string): Promise<any> {
    const response = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
      credentials: 'include'
    })
    const result = await response.json()

    if (result.code !== 0) {
      throw new Error(`获取视频信息失败: ${String(result.message)}`)
    }

    return result.data
  }

  private async getSubtitleList(aid: number, cid: number): Promise<any[]> {
    const response = await fetch(`https://api.bilibili.com/x/player/wbi/v2?aid=${aid}&cid=${cid}`, {
      credentials: 'include'
    })
    const result = await response.json()

    if (result.code !== 0) {
      throw new Error(`获取字幕列表失败: ${String(result.message)}`)
    }

    return result.data.subtitle.subtitles.filter((item: any) => item.subtitle_url)
  }

  /**
   * 下载字幕文件
   * 注意：这里不使用 credentials: 'include' 来避免CORS错误
   * 字幕URL是公开的，不需要用户认证
   */
  private async downloadSubtitle(subtitleInfo: any): Promise<any> {
    let url = subtitleInfo.subtitle_url
    if (url.startsWith('http://')) {
      url = url.replace('http://', 'https://')
    }

    // 修复CORS错误：字幕下载不需要携带cookies，使用原有代码的实现方式
    const response = await fetch(url)
    return await response.json()
  }

  private sendResponse(response: SubtitleResponse): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(response))
    } else {
      this.log('WebSocket未连接，无法发送响应', { response })
    }
  }

  private log(message: string, data?: any): void {
    const timestamp = new Date().toISOString()
    const logMessage = `[InjectWebSocketService] ${timestamp} - ${message}`

    if (data) {
      console.log(logMessage, data)
    } else {
      console.log(logMessage)
    }
  }
}
