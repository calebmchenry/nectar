export type HiveView = 'gardens' | 'seedbed';

export interface ViewNavOptions {
  onChange(view: HiveView): void;
}

export class ViewNav {
  readonly element: HTMLElement;

  private readonly gardensButton: HTMLButtonElement;
  private readonly seedbedButton: HTMLButtonElement;
  private readonly onChange: (view: HiveView) => void;

  constructor(options: ViewNavOptions) {
    this.onChange = options.onChange;

    this.element = document.createElement('nav');
    this.element.className = 'view-nav';

    this.gardensButton = document.createElement('button');
    this.gardensButton.type = 'button';
    this.gardensButton.className = 'view-nav-btn';
    this.gardensButton.textContent = 'Gardens';
    this.gardensButton.addEventListener('click', () => this.onChange('gardens'));

    this.seedbedButton = document.createElement('button');
    this.seedbedButton.type = 'button';
    this.seedbedButton.className = 'view-nav-btn';
    this.seedbedButton.textContent = 'Seedbed';
    this.seedbedButton.addEventListener('click', () => this.onChange('seedbed'));

    this.element.append(this.gardensButton, this.seedbedButton);
  }

  setActive(view: HiveView): void {
    this.gardensButton.classList.toggle('is-active', view === 'gardens');
    this.seedbedButton.classList.toggle('is-active', view === 'seedbed');
  }

  setView(view: HiveView): void {
    this.setActive(view);
  }
}
