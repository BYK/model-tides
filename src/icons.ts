import {
    Check,
    ChevronDown,
    Copy,
    Download,
    ExternalLink,
    Moon,
    RotateCcw,
    Share2,
    Sun,
    ZoomIn,
    ZoomOut,
    createIcons,
} from 'lucide';

const icons = {
    Check,
    ChevronDown,
    Copy,
    Download,
    ExternalLink,
    Moon,
    RotateCcw,
    Share2,
    Sun,
    ZoomIn,
    ZoomOut,
};

/** Replaces the small, semantic action icons used across the product. */
export function mountIcons(root: HTMLElement): void {
    if (typeof root.querySelectorAll !== 'function') return;
    createIcons({
        icons,
        nameAttr: 'data-lucide',
        attrs: {
            'aria-hidden': 'true',
            height: '1em',
            width: '1em',
            'stroke-width': '1.8',
        },
        root,
    });
}
