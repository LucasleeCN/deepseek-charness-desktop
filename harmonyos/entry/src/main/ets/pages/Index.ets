import { webview } from '@kit.ArkWeb';
import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';

const DEFAULT_HOST_URL: string = 'http://192.168.1.100:8787';
const PREFERENCES_NAME: string = 'host_settings';
const KEY_HOST_URL: string = 'host_url';

@Entry
@Component
struct Index {
  @State webSrc: string = DEFAULT_HOST_URL;
  @State inputUrl: string = DEFAULT_HOST_URL;
  @State statusText: string = '未连接';
  @State errorVisible: boolean = false;
  @State connected: boolean = false;
  @State loadError: boolean = false;
  @State currentUrl: string = '';

  private webController: webview.WebviewController = new webview.WebviewController();
  private dataPreferences: preferences.Preferences | null = null;
  private context = getContext(this) as common.UIAbilityContext;

  aboutToAppear(): void {
    try {
      this.dataPreferences = preferences.getPreferencesSync(this.context, { name: PREFERENCES_NAME });
      const saved: string = this.dataPreferences.getSync(KEY_HOST_URL, DEFAULT_HOST_URL) as string;
      this.webSrc = this.normalizeUrl(saved) || DEFAULT_HOST_URL;
      this.inputUrl = this.webSrc;
    } catch (err) {
      this.statusText = '读取本地设置失败，已使用默认地址';
    }
  }

  private normalizeUrl(raw: string): string {
    let value: string = raw.trim();
    if (value === '') {
      return '';
    }
    if (!/^https?:\/\//i.test(value)) {
      value = `http://${value}`;
    }
    while (value.endsWith('/')) {
      value = value.slice(0, -1);
    }
    return value;
  }

  private persistUrl(url: string): void {
    if (this.dataPreferences === null) {
      return;
    }
    try {
      this.dataPreferences.putSync(KEY_HOST_URL, url);
      void this.dataPreferences.flush();
    } catch (err) {
      this.statusText = '宿主地址已连接，但本地保存失败';
    }
  }

  private connect(): void {
    const normalized: string = this.normalizeUrl(this.inputUrl);
    if (normalized === '') {
      this.statusText = '请输入宿主地址';
      this.errorVisible = true;
      return;
    }
    this.webSrc = normalized;
    this.inputUrl = normalized;
    this.currentUrl = normalized;
    this.connected = false;
    this.loadError = false;
    this.errorVisible = false;
    this.statusText = '正在连接…';
    this.persistUrl(normalized);
    this.webController.loadUrl(normalized);
  }

  private retry(): void {
    if (this.webSrc === '') {
      this.connect();
      return;
    }
    this.connected = false;
    this.loadError = false;
    this.errorVisible = false;
    this.statusText = '正在重新连接…';
    this.webController.loadUrl(this.webSrc);
  }

  build() {
    Column() {
      Column({ space: 8 }) {
        Text('宿主地址（桌面端“手机远程访问”默认 8787 端口）')
          .fontSize(13)
          .fontColor('#4A5568')
          .width('100%')

        Row() {
          TextInput({ text: this.inputUrl, placeholder: 'http://192.168.1.100:8787' })
            .layoutWeight(1)
            .height(44)
            .fontSize(14)
            .fontColor('#172033')
            .backgroundColor('#FFFFFF')
            .onChange((value: string) => {
              this.inputUrl = value;
            })

          Button(this.connected ? '重连' : '连接')
            .width(72)
            .height(44)
            .margin({ left: 8 })
            .fontSize(14)
            .onClick(() => {
              this.connect();
            })
        }
        .width('100%')

        Row() {
          Text(this.currentUrl === '' ? this.statusText : `${this.statusText} · ${this.currentUrl}`)
            .fontSize(12)
            .fontColor(this.errorVisible ? '#B3261E' : '#667085')
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .width('100%')
      }
      .width('100%')
      .padding({ left: 12, right: 12, top: 10, bottom: 10 })
      .backgroundColor('#EEF0F4')

      Stack() {
        Web({ src: this.webSrc, controller: this.webController })
          .javaScriptAccess(true)
          .domStorageAccess(true)
          .databaseAccess(true)
          .zoomAccess(true)
          .mixedMode(MixedMode.All)
          .width('100%')
          .height('100%')
          .onPageBegin((event) => {
            this.connected = false;
            this.loadError = false;
            this.errorVisible = false;
            this.statusText = '正在连接…';
          })
          .onPageEnd((event) => {
            if (this.loadError) {
              return;
            }
            this.connected = true;
            this.errorVisible = false;
            this.statusText = '已连接';
          })
          .onErrorReceive((event) => {
            this.connected = false;
            this.loadError = true;
            this.errorVisible = true;
            if (event) {
              this.statusText = `加载失败（错误码 ${event.error.getErrorCode()}），请检查宿主地址、防火墙与网络`;
            } else {
              this.statusText = '加载失败，请检查宿主地址、防火墙与网络';
            }
          })

        if (this.errorVisible) {
          Column({ space: 12 }) {
            Text('无法加载宿主页面')
              .fontSize(16)
              .fontColor('#172033')
            Text(this.statusText)
              .fontSize(13)
              .fontColor('#667085')
              .textAlign(TextAlign.Center)
            Button('重试')
              .width(96)
              .height(44)
              .onClick(() => {
                this.retry();
              })
          }
          .width('100%')
          .height('100%')
          .justifyContent(FlexAlign.Center)
          .backgroundColor('#F6F7F9')
          .padding({ left: 24, right: 24 })
        }
      }
      .layoutWeight(1)
      .width('100%')
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#F6F7F9')
  }
}
