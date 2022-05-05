import {
    getRelativeLocation,
    SerializedGridObject,
    getGridLocation,
} from '../gridview/gridview';
import { Position } from '../dnd/droptarget';
import { tail, sequenceEquals } from '../array';
import { GroupviewPanelState, IDockviewPanel } from '../groupview/groupPanel';
import { DockviewGroupPanel } from './dockviewGroupPanel';
import { CompositeDisposable } from '../lifecycle';
import { Event, Emitter } from '../events';
import { Watermark } from './components/watermark/watermark';
import {
    IContentRenderer,
    ITabRenderer,
    IWatermarkRenderer,
} from '../groupview/types';
import { sequentialNumberGenerator } from '../math';
import { DefaultDeserializer, IPanelDeserializer } from './deserializer';
import { createComponent } from '../panel/componentFactory';
import {
    AddGroupOptions,
    AddPanelOptions,
    DockviewComponentOptions,
    MovementOptions,
    TabContextMenuEvent,
} from './options';
import {
    BaseGrid,
    IBaseGrid,
    toTarget,
} from '../gridview/baseComponentGridview';
import { DockviewApi } from '../api/component.api';
import { LayoutMouseEvent, MouseEventKind } from '../groupview/tab';
import { Orientation } from '../splitview/core/splitview';
import { DefaultTab } from './components/tab/defaultTab';
import {
    GroupChangeKind2,
    GroupOptions,
    GroupPanelViewState,
    GroupviewDropEvent,
} from '../groupview/groupview';
import { GroupPanel } from '../groupview/groupviewPanel';
import { DefaultGroupPanelView } from './defaultGroupPanelView';

const nextGroupId = sequentialNumberGenerator();

export interface PanelReference {
    update: (event: { params: { [key: string]: any } }) => void;
    remove: () => void;
}

export interface SerializedDockview {
    grid: {
        root: SerializedGridObject<GroupPanelViewState>;
        height: number;
        width: number;
        orientation: Orientation;
    };
    panels: { [key: string]: GroupviewPanelState };
    activeGroup?: string;
    options?: { tabHeight?: number };
}

export type DockviewComponentUpdateOptions = Pick<
DockviewComponentOptions,
    | 'orientation'
    | 'components'
    | 'frameworkComponents'
    | 'tabComponents'
    | 'frameworkTabComponents'
    | 'showDndOverlay'
    | 'watermarkFrameworkComponent'
>;

export interface DockviewDropEvent extends GroupviewDropEvent {
    api: DockviewApi;
}

export interface IDockviewComponent extends IBaseGrid<GroupPanel> {
    readonly activePanel: IDockviewPanel | undefined;
    readonly totalPanels: number;
    readonly panels: IDockviewPanel[];
    readonly onDidDrop: Event<DockviewDropEvent>;
    tabHeight: number | undefined;
    deserializer: IPanelDeserializer | undefined;
    updateOptions(options: DockviewComponentUpdateOptions): void;
    moveGroupOrPanel(
        referenceGroup: GroupPanel,
        groupId: string,
        itemId: string,
        target: Position,
        index?: number
    ): void;
    doSetGroupActive: (group: GroupPanel, skipFocus?: boolean) => void;
    removeGroup: (group: GroupPanel) => void;
    options: DockviewComponentOptions;
    addPanel(options: AddPanelOptions): IDockviewPanel;
    removePanel(panel: IDockviewPanel): void;
    getGroupPanel: (id: string) => IDockviewPanel | undefined;
    fireMouseEvent(event: LayoutMouseEvent): void;
    createWatermarkComponent(): IWatermarkRenderer;
    // lifecycle
    addEmptyGroup(options?: AddGroupOptions): void;
    closeAllGroups(): void;
    // events
    onTabInteractionEvent: Event<LayoutMouseEvent>;
    onTabContextMenu: Event<TabContextMenuEvent>;
    moveToNext(options?: MovementOptions): void;
    moveToPrevious(options?: MovementOptions): void;
    setActivePanel(panel: IDockviewPanel): void;
    focus(): void;
    toJSON(): SerializedDockview;
    fromJSON(data: SerializedDockview): void;
    //
    readonly onDidRemovePanel: Event<IDockviewPanel>;
    readonly onDidAddPanel: Event<IDockviewPanel>;
    readonly onDidLayoutfromJSON: Event<void>;
    readonly onDidActivePanelChange: Event<IDockviewPanel | undefined>;
}

export class DockviewComponent
    extends BaseGrid<GroupPanel>
    implements IDockviewComponent
{
    private _deserializer: IPanelDeserializer | undefined;
    private _api: DockviewApi;
    private _options: DockviewComponentOptions;

    // events
    private readonly _onTabInteractionEvent = new Emitter<LayoutMouseEvent>();
    readonly onTabInteractionEvent: Event<LayoutMouseEvent> =
        this._onTabInteractionEvent.event;

    private readonly _onTabContextMenu = new Emitter<TabContextMenuEvent>();
    readonly onTabContextMenu: Event<TabContextMenuEvent> =
        this._onTabContextMenu.event;

    private readonly _onDidDrop = new Emitter<DockviewDropEvent>();
    readonly onDidDrop: Event<DockviewDropEvent> = this._onDidDrop.event;

    private readonly _onDidRemovePanel = new Emitter<IDockviewPanel>();
    readonly onDidRemovePanel: Event<IDockviewPanel> =
        this._onDidRemovePanel.event;

    private readonly _onDidAddPanel = new Emitter<IDockviewPanel>();
    readonly onDidAddPanel: Event<IDockviewPanel> = this._onDidAddPanel.event;

    private readonly _onDidLayoutfromJSON = new Emitter<void>();
    readonly onDidLayoutfromJSON: Event<void> = this._onDidLayoutfromJSON.event;

    private readonly _onDidActivePanelChange = new Emitter<
        IDockviewPanel | undefined
    >();
    readonly onDidActivePanelChange: Event<IDockviewPanel | undefined> =
        this._onDidActivePanelChange.event;

    get totalPanels(): number {
        return this.panels.length;
    }

    get panels(): IDockviewPanel[] {
        return this.groups.flatMap((group) => group.panels);
    }

    get deserializer(): IPanelDeserializer | undefined {
        return this._deserializer;
    }

    set deserializer(value: IPanelDeserializer | undefined) {
        this._deserializer = value;
    }

    get options(): DockviewComponentOptions {
        return this._options;
    }

    get activePanel(): IDockviewPanel | undefined {
        const activeGroup = this.activeGroup;

        if (!activeGroup) {
            return undefined;
        }

        return activeGroup.activePanel;
    }

    set tabHeight(height: number | undefined) {
        this.options.tabHeight = height;
        this._groups.forEach((value) => {
            value.value.model.header.height = height;
        });
    }

    get tabHeight(): number | undefined {
        return this.options.tabHeight;
    }

    constructor(element: HTMLElement, options: DockviewComponentOptions) {
        super(element, {
            proportionalLayout: true,
            orientation: options.orientation || Orientation.HORIZONTAL,
            styles: options.styles,
        });

        this.addDisposables(
            this._onTabInteractionEvent,
            this._onTabContextMenu,
            this._onDidDrop,
            Event.any(
                this.onDidAddPanel,
                this.onDidRemovePanel,
                this.onDidActivePanelChange
            )(() => {
                this._bufferOnDidLayoutChange.fire();
            })
        );

        this._options = options;

        if (!this.options.components) {
            this.options.components = {};
        }
        if (!this.options.frameworkComponents) {
            this.options.frameworkComponents = {};
        }
        if (!this.options.frameworkTabComponents) {
            this.options.frameworkTabComponents = {};
        }
        if (!this.options.tabComponents) {
            this.options.tabComponents = {};
        }
        if (
            !this.options.watermarkComponent &&
            !this.options.watermarkFrameworkComponent
        ) {
            this.options.watermarkComponent = Watermark;
        }

        this._api = new DockviewApi(this);
    }

    updateOptions(options: DockviewComponentUpdateOptions): void {
        const hasOrientationChanged =
            typeof options.orientation === 'string' &&
            this.options.orientation !== options.orientation;

        this._options = { ...this.options, ...options };

        if (hasOrientationChanged) {
            this.gridview.orientation = options.orientation!;
        }

        this.layout(this.gridview.width, this.gridview.height, true);
    }

    focus(): void {
        this.activeGroup?.focus();
    }

    getGroupPanel(id: string): IDockviewPanel | undefined {
        return this.panels.find((panel) => panel.id === id);
    }

    setActivePanel(panel: IDockviewPanel): void {
        this.doSetGroupActive(panel.group);
        panel.group.model.openPanel(panel);
    }

    moveToNext(options: MovementOptions = {}): void {
        if (!options.group) {
            if (!this.activeGroup) {
                return;
            }
            options.group = this.activeGroup;
        }

        if (options.includePanel && options.group) {
            if (
                options.group.activePanel !==
                options.group.panels[
                    options.group.panels.length - 1
                ]
            ) {
                options.group.model.moveToNext({ suppressRoll: true });
                return;
            }
        }

        const location = getGridLocation(options.group.element);
        const next = <GroupPanel>this.gridview.next(location)?.view
        this.doSetGroupActive(next);
    }

    moveToPrevious(options: MovementOptions = {}): void {
        if (!options.group) {
            if (!this.activeGroup) {
                return;
            }
            options.group = this.activeGroup;
        }

        if (options.includePanel && options.group) {
            if (
                options.group.activePanel !==
                options.group.panels[0]
            ) {
                options.group.model.moveToPrevious({ suppressRoll: true });
                return;
            }
        }

        const location = getGridLocation(options.group.element);
        const next = this.gridview.previous(location)?.view;
        if (next) {
            this.doSetGroupActive(next as GroupPanel);
        }
    }

    /**
     * Serialize the current state of the layout
     *
     * @returns A JSON respresentation of the layout
     */
    toJSON(): SerializedDockview {
        const data = this.gridview.serialize();

        const panels = this.panels.reduce((collection, panel) => {
            collection[panel.id] = panel.toJSON();
            return collection;
        }, {} as { [key: string]: GroupviewPanelState });

        return {
            grid: data,
            panels,
            activeGroup: this.activeGroup?.id,
            options: { tabHeight: this.tabHeight },
        };
    }

    fromJSON(data: SerializedDockview): void {
        const groups = Array.from(this._groups.values()).map((_) => _.value);

        for (const group of groups) {
            // remove the group will automatically remove the panels
            this.removeGroup(group, true);
        }

        this.gridview.clear();

        if (!this.deserializer) {
            throw new Error('invalid deserializer');
        }
        const { grid, panels, options, activeGroup } = data;

        if (typeof options?.tabHeight === 'number') {
            this.tabHeight = options.tabHeight;
        }

        if (!this.deserializer) {
            throw new Error('no deserializer provided');
        }

        this.gridview.deserialize(
            grid,
            new DefaultDeserializer(this, {
                createPanel: (id, group) => {
                    const panelData = panels[id];
                    return this.deserializer!.fromJSON(panelData, group);
                },
            })
        );

        if (typeof activeGroup === 'string') {
            const panel = this.getPanel(activeGroup);
            if (panel) {
                this.doSetGroupActive(panel);
            }
        }

        this.gridview.layout(this.width, this.height);

        this._onDidLayoutfromJSON.fire();
    }

    closeAllGroups(): void {
        for (const entry of this._groups.entries()) {
            const [_, group] = entry;

            group.value.model.closeAllPanels();
        }
    }

    fireMouseEvent(event: LayoutMouseEvent): void {
        if (event.kind === MouseEventKind.CONTEXT_MENU) {
            if (event.tab && event.panel) {
                this._onTabContextMenu.fire({
                    event: event.event,
                    api: this._api,
                    panel: event.panel,
                });
            }
        }
    }

    addPanel(options: AddPanelOptions): IDockviewPanel {
        if (this.panels.find((_) => _.id === options.id)) {
            throw new Error(`panel with id ${options.id} already exists`);
        }

        let referenceGroup: GroupPanel | undefined;

        if (options.position?.referencePanel) {
          const referencePanel = this.getGroupPanel(
              options.position.referencePanel
          );

          if (!referencePanel) {
              throw new Error(
                  `referencePanel ${options.position.referencePanel} does not exist`
              );
          }

            referenceGroup = this.findGroup(referencePanel);
        } else {
            referenceGroup = this.activeGroup;
        }

      let panel: IDockviewPanel

        if (referenceGroup) {
            const target = toTarget(options.position?.direction || 'within');
            if (target === Position.Center) {
               panel = this.createPanel(options, referenceGroup)
                referenceGroup.model.openPanel(panel);
            } else {
                const location = getGridLocation(referenceGroup.element);
                const relativeLocation = getRelativeLocation(
                    this.gridview.orientation,
                    location,
                    target
                );
                const group = this.createGroupAtLocation(relativeLocation);
                panel = this.createPanel(options, group)
                group.model.openPanel(panel);
            }
        } else {
          const group = this.createGroupAtLocation();
          panel = this.createPanel(options, group);
          group.model.openPanel(panel);
        }

        return panel;
    }

    removePanel(
        panel: IDockviewPanel,
        options: { removeEmptyGroup: boolean; skipDispose: boolean } = {
            removeEmptyGroup: true,
            skipDispose: false,
        }
    ): void {
        const group = panel.group;

        if (!group) {
            throw new Error(
                `cannot remove panel ${panel.id}. it's missing a group.`
            );
        }

        group.model.removePanel(panel);

        panel.dispose();

        const retainGroupForWatermark = this.size === 1;

        if (
            !retainGroupForWatermark &&
            group.size === 0 &&
            options.removeEmptyGroup
        ) {
            this.removeGroup(group);
        }
    }

    createWatermarkComponent(): IWatermarkRenderer {
        return createComponent(
            'watermark-id',
            'watermark-name',
            this.options.watermarkComponent
                ? { 'watermark-name': this.options.watermarkComponent }
                : {},
            this.options.watermarkFrameworkComponent
                ? { 'watermark-name': this.options.watermarkFrameworkComponent }
                : {},
            this.options.frameworkComponentFactory?.watermark
        );
    }

    addEmptyGroup(options: AddGroupOptions): void {
        const group = this.createGroup();

        if (options) {
            const referencePanel = this.panels.find(
                (panel) => panel.id === options.referencePanel
            );

            if (!referencePanel) {
                throw new Error(
                    `reference panel ${options.referencePanel} does not exist`
                );
            }

            const referenceGroup = this.findGroup(referencePanel);

            if (!referenceGroup) {
                throw new Error(
                    `reference group for reference panel ${options.referencePanel} does not exist`
                );
            }

            const target = toTarget(options.direction || 'within');

            const location = getGridLocation(referenceGroup.element);
            const relativeLocation = getRelativeLocation(
                this.gridview.orientation,
                location,
                target
            );
            this.doAddGroup(group, relativeLocation);
        } else {
            this.doAddGroup(group);
        }
    }

    removeGroup(group: GroupPanel, skipActive = false): void {
        const panels = [...group.panels]; // reassign since group panels will mutate

        for (const panel of panels) {
            this.removePanel(panel, {
                removeEmptyGroup: false,
                skipDispose: false,
            });
        }

        super.doRemoveGroup(group, { skipActive });
    }

    moveGroupOrPanel(
        referenceGroup: GroupPanel,
        groupId: string,
        itemId: string,
        target: Position,
        index?: number
    ): void {
        const sourceGroup = groupId
            ? this._groups.get(groupId)?.value
            : undefined;

        if (!target || target === Position.Center) {
            const groupItem: IDockviewPanel | undefined =
                sourceGroup?.model.removePanel(itemId) ||
                this.panels.find((panel) => panel.id === itemId);

            if (!groupItem) {
                throw new Error(`No panel with id ${itemId}`);
            }

            if (sourceGroup?.model.size === 0) {
                this.doRemoveGroup(sourceGroup);
            }

            referenceGroup.model.openPanel(groupItem, { index });
        } else {
            const referenceLocation = getGridLocation(referenceGroup.element);
            const targetLocation = getRelativeLocation(
                this.gridview.orientation,
                referenceLocation,
                target
            );

            if (sourceGroup && sourceGroup.size < 2) {
                const [targetParentLocation, to] = tail(targetLocation);
                const sourceLocation = getGridLocation(sourceGroup.element);
                const [sourceParentLocation, from] = tail(sourceLocation);

                if (
                    sequenceEquals(sourceParentLocation, targetParentLocation)
                ) {
                    // special case when 'swapping' two views within same grid location
                    // if a group has one tab - we are essentially moving the 'group'
                    // which is equivalent to swapping two views in this case
                    this.gridview.moveView(sourceParentLocation, from, to);
                } else {
                    // source group will become empty so delete the group
                    const targetGroup = this.doRemoveGroup(sourceGroup, {
                        skipActive: true,
                        skipDispose: true,
                    });

                    // after deleting the group we need to re-evaulate the ref location
                    const updatedReferenceLocation = getGridLocation(
                        referenceGroup.element
                    );
                    const location = getRelativeLocation(
                        this.gridview.orientation,
                        updatedReferenceLocation,
                        target
                    );
                    this.doAddGroup(targetGroup, location);
                }
            } else {
                const groupItem: IDockviewPanel | undefined =
                    sourceGroup?.model.removePanel(itemId) ||
                    this.panels.find((panel) => panel.id === itemId);

                if (!groupItem) {
                    throw new Error(`No panel with id ${itemId}`);
                }

                const dropLocation = getRelativeLocation(
                    this.gridview.orientation,
                    referenceLocation,
                    target
                );

                const group = this.createGroupAtLocation( dropLocation);
                group.model.openPanel(groupItem);
            }
        }
    }

    override doSetGroupActive(
        group: GroupPanel | undefined,
        skipFocus?: boolean
    ): void {
        const isGroupAlreadyFocused = this._activeGroup === group;
        super.doSetGroupActive(group, skipFocus);

        if (!isGroupAlreadyFocused && this._activeGroup?.activePanel) {
            this._onDidActivePanelChange.fire(
                this._activeGroup?.activePanel
            );
        }
    }

    createGroup(options?: GroupOptions): GroupPanel {
        if (!options) {
            options = { tabHeight: this.tabHeight };
        }
        if (typeof options.tabHeight !== 'number') {
            options.tabHeight = this.tabHeight;
        }

        let id = options?.id;

        if (id && this._groups.has(options.id!)) {
            console.warn(
                `Duplicate group id ${options?.id}. reassigning group id to avoid errors`
            );
            id = undefined;
        }

        if (!id) {
            id = nextGroupId.next();
            while (this._groups.has(id)) {
                id = nextGroupId.next();
            }
        }

        const view = new GroupPanel(this, id, options);
        view.init({ params: {}, containerApi: <any>null }); // required to initialized .part and allow for correct disposal of group

        if (!this._groups.has(view.id)) {
            const disposable = new CompositeDisposable(
                view.model.onMove((event) => {
                    const { groupId, itemId, target, index } = event;
                    this.moveGroupOrPanel(view, groupId, itemId, target, index);
                }),
                view.model.onDidDrop((event) => {
                    this._onDidDrop.fire({ ...event, api: this._api });
                }),
                view.model.onDidGroupChange((event) => {
                    switch (event.kind) {
                        case GroupChangeKind2.ADD_PANEL:
                            if (event.panel) {
                                this._onDidAddPanel.fire(event.panel);
                            }
                            break;
                        case GroupChangeKind2.REMOVE_PANEL:
                            if (event.panel) {
                                this._onDidRemovePanel.fire(event.panel);
                            }
                            break;
                        case GroupChangeKind2.PANEL_ACTIVE:
                            this._onDidActivePanelChange.fire(event.panel);
                            break;
                    }
                })
            );

            this._groups.set(view.id, { value: view, disposable });
        }

        // TODO: must be called after the above listeners have been setup,
        // not an ideal pattern
        view.initialize();

        if (typeof this.options.tabHeight === 'number') {
            view.model.header.height = this.options.tabHeight;
        }

        return view;
    }

    private createPanel(options: AddPanelOptions, group: GroupPanel): IDockviewPanel {
        const view = new DefaultGroupPanelView({
            content: this.createContentComponent(options.id, options.component),
            tab: this.createTabComponent(options.id, options.tabComponent),
        });

        const panel = new DockviewGroupPanel(options.id, this, this._api, group);
        panel.init({
            view,
            title: options.title || options.id,
            suppressClosable: options?.suppressClosable,
            params: options?.params || {},
        });

        return panel;
    }

    private createContentComponent(
        id: string,
        componentName: string
    ): IContentRenderer {
        return createComponent(
            id,
            componentName,
            this.options.components || {},
            this.options.frameworkComponents,
            this.options.frameworkComponentFactory?.content
        );
    }

    private createTabComponent(
        id: string,
        componentName?: string
    ): ITabRenderer {
        return createComponent(
            id,
            componentName,
            this.options.tabComponents || {},
            this.options.frameworkTabComponents,
            this.options.frameworkComponentFactory?.tab,
            () => new DefaultTab()
        );
    }

    private createGroupAtLocation(
        location: number[] = [0]
    ): GroupPanel {
        const group = this.createGroup();
        this.doAddGroup(group, location);
        return group
    }

    private findGroup(panel: IDockviewPanel): GroupPanel | undefined {
        return Array.from(this._groups.values()).find((group) =>
            group.value.model.containsPanel(panel)
        )?.value;
    }

    public dispose(): void {
        super.dispose();

        this._onDidActivePanelChange.dispose();
        this._onDidAddPanel.dispose();
        this._onDidRemovePanel.dispose();
        this._onDidLayoutfromJSON.dispose();
    }
}
