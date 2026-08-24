import type { AnchorHTMLAttributes, MouseEvent } from 'react';

interface InternalLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  readonly href: string;
}

export default function InternalLink({
  href,
  onClick,
  ...props
}: InternalLinkProps) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (
      event.defaultPrevented
      || event.button !== 0
      || event.metaKey
      || event.ctrlKey
      || event.shiftKey
      || event.altKey
      || props.target === '_blank'
    ) {
      return;
    }

    const next = new URL(href, window.location.origin);
    if (next.origin !== window.location.origin) return;

    event.preventDefault();
    window.history.pushState({}, '', `${next.pathname}${next.search}${next.hash}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  };

  return <a href={href} onClick={handleClick} {...props} />;
}
