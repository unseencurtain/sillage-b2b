<?php
/**
 * Render product images straight from the vendor's CDN.
 *
 * @package Sillage_Bridge
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Serves product images from the vendor URL stored in postmeta.
 *
 * There are no attachments and no files under wp-content/uploads for synced products. Downloading
 * 52,000 images would cost hours of import time and gigabytes of disk for no benefit, since both
 * vendors already serve them over HTTPS from their own infrastructure. The URL is emitted exactly
 * as the vendor supplied it.
 *
 * ## Why this hooks the attachment layer rather than any gallery template
 *
 * Themes do not agree on how a product image is rendered. WooCommerce's own templates call
 * `wp_get_attachment_image()`, Blocksy builds its gallery from attachment IDs and ignores the
 * `woocommerce_before_single_product_summary` output entirely, Elementor has its own widget, Astra
 * uses theme builders, and the block templates go through yet another path. Overriding each
 * renderer means a new hook for every theme, and silent breakage the day the theme changes.
 *
 * What all of them share is the attachment ID. So instead of replacing renderers, this makes the
 * product *look like* it has a thumbnail: `post_thumbnail_id` returns an ID, and the resolution
 * filters below turn that ID into the vendor URL. Every theme, the REST API, wp-admin, structured
 * data and the block editor then work unmodified.
 *
 * The ID handed out is the product's own post ID. A synthetic ID would be tidier but
 * `wp_get_attachment_image()` calls `get_post()` on it, and a null post there is fatal — the
 * product post is guaranteed to exist.
 *
 * This carries one real limitation: one image per product, since a post ID identifies exactly one
 * URL. Both vendors currently ship exactly one image per product (verified across all 52,270
 * products with an image), so nothing is lost. A vendor with real galleries would need synthetic
 * IDs and a matching `get_post` shim.
 */
final class Sillage_Images {

	private const THUMB_META = '_external_thumbnail_url';

	/** Memoised per request; these filters run on every image on the page. */
	private array $url_cache = array();

	public function register(): void {
		// Make the product report a thumbnail. Everything else follows from this.
		add_filter( 'post_thumbnail_id', array( $this, 'thumbnail_id' ), 10, 2 );
		add_filter( 'woocommerce_product_get_image_id', array( $this, 'product_image_id' ), 10, 2 );

		// Resolve that ID to the vendor URL. image_downsize is the single choke point that
		// wp_get_attachment_image(), _src(), _url() and every theme helper funnel through.
		add_filter( 'image_downsize', array( $this, 'downsize' ), 10, 3 );
		add_filter( 'wp_get_attachment_url', array( $this, 'attachment_url' ), 10, 2 );
		// Elementor / Astra helpers sometimes call wp_get_attachment_image_src directly and
		// skip image_downsize when a prior filter already short-circuited — cover that path too.
		add_filter( 'wp_get_attachment_image_src', array( $this, 'attachment_image_src' ), 10, 4 );

		// Empty gallery → use the main image so Elementor gallery widgets still render something.
		add_filter( 'woocommerce_product_get_gallery_image_ids', array( $this, 'gallery_image_ids' ), 10, 2 );

		// Alt text is supplied as attachment meta rather than as an image attribute, because the
		// Store API and the block editor read the meta directly and never build an <img> tag.
		add_filter( 'get_post_metadata', array( $this, 'image_alt_meta' ), 10, 4 );

		// Structured data and social meta read the attachment image, which does not exist.
		add_filter( 'woocommerce_structured_data_product', array( $this, 'structured_data' ), 10, 2 );

		// Blocksy live search builds ct_featured_media via WP_REST_Attachments_Controller, which
		// calls wp_get_attachment_url(). Modern WP returns false before that filter when the ID
		// is not post_type=attachment — our product stand-in IDs never reach attachment_url().
		// Guarded theme shim: no-ops unless Blocksy fires the live-search fields action.
		add_action( 'blocksy:rest_api:live_search:fields', array( $this, 'register_live_search_media_field' ) );
	}

	/**
	 * The vendor thumbnail URL for a product, or an empty string.
	 *
	 * @param int $product_id Product post ID.
	 */
	public static function thumbnail_url( int $product_id ): string {
		$url = get_post_meta( $product_id, self::THUMB_META, true );
		if ( ! is_string( $url ) ) {
			return '';
		}
		$url = trim( $url );
		// "None" / "null" leaked from Python; never emit those as <img src>.
		if ( $url === '' || strcasecmp( $url, 'none' ) === 0 || strcasecmp( $url, 'null' ) === 0 ) {
			return '';
		}
		if ( ! preg_match( '#^https?://#i', $url ) ) {
			return '';
		}
		return $url;
	}

	/**
	 * Cached lookup guarded by post type, since the resolution filters fire for every image on
	 * the page including logos, avatars and block images.
	 *
	 * @param int $id Candidate post ID.
	 */
	private function url_for( int $id ): string {
		if ( $id <= 0 ) {
			return '';
		}
		if ( isset( $this->url_cache[ $id ] ) ) {
			return $this->url_cache[ $id ];
		}

		$url = 'product' === get_post_type( $id ) ? self::thumbnail_url( $id ) : '';

		$this->url_cache[ $id ] = $url;
		return $url;
	}

	/**
	 * Report the product's own ID as its thumbnail ID.
	 *
	 * @param int|string  $thumbnail_id Existing thumbnail ID, 0 when there is none.
	 * @param int|WP_Post $post         Post or post ID.
	 * @return int
	 */
	public function thumbnail_id( $thumbnail_id, $post = null ) {
		if ( ! empty( $thumbnail_id ) ) {
			return (int) $thumbnail_id;
		}
		$post_id = $post instanceof WP_Post ? $post->ID : (int) $post;

		return '' === $this->url_for( $post_id ) ? (int) $thumbnail_id : $post_id;
	}

	/**
	 * Same, for WC_Product::get_image_id().
	 *
	 * @param int|string $image_id Existing image ID.
	 * @param mixed      $product  Product object.
	 * @return int
	 */
	public function product_image_id( $image_id, $product = null ) {
		if ( ! empty( $image_id ) || ! $product instanceof WC_Product ) {
			return (int) $image_id;
		}
		$product_id = $product->get_id();

		return '' === $this->url_for( $product_id ) ? (int) $image_id : $product_id;
	}

	/**
	 * Resolve an ID to the vendor URL, short-circuiting WordPress's file-based sizing.
	 *
	 * Width and height are reported as 0 deliberately. The vendor feeds do not carry image
	 * dimensions, and guessing them would emit `width`/`height` attributes that fix a wrong aspect
	 * ratio on the element. Zero makes `image_hwstring()` omit both, so the browser uses the
	 * image's real dimensions.
	 *
	 * @param bool|array   $downsize Short-circuit value.
	 * @param int          $id       Attachment ID.
	 * @param string|int[] $size     Requested size.
	 * @return bool|array
	 */
	public function downsize( $downsize, $id, $size = 'medium' ) {
		unset( $size );
		if ( false !== $downsize ) {
			return $downsize;
		}
		$url = $this->url_for( (int) $id );
		if ( '' === $url ) {
			return $downsize;
		}
		return array( $url, 0, 0, false );
	}

	/**
	 * Resolve wp_get_attachment_url() for a product standing in as its own attachment.
	 *
	 * @param string $url     Resolved URL, pointing into wp-content/uploads.
	 * @param int    $post_id Attachment ID.
	 * @return string
	 */
	public function attachment_url( $url, $post_id ) {
		$external = $this->url_for( (int) $post_id );
		return '' === $external ? $url : $external;
	}

	/**
	 * Resolve wp_get_attachment_image_src() for Elementor / Astra product widgets.
	 *
	 * @param array|false  $image  Existing [url, width, height] or false.
	 * @param int          $id     Attachment ID.
	 * @param string|int[] $size   Requested size.
	 * @param bool         $icon   Whether an icon was requested.
	 * @return array|false
	 */
	public function attachment_image_src( $image, $id, $size = 'thumbnail', $icon = false ) {
		unset( $size, $icon );
		$url = $this->url_for( (int) $id );
		if ( '' === $url ) {
			return $image;
		}
		return array( $url, 0, 0, false );
	}

	/**
	 * If the product has no gallery attachments, expose the main image ID so Elementor galleries
	 * still render the vendor URL via the filters above.
	 *
	 * @param int[]       $ids     Gallery attachment IDs.
	 * @param mixed       $product Product object.
	 * @return int[]
	 */
	public function gallery_image_ids( $ids, $product = null ) {
		if ( ! empty( $ids ) || ! $product instanceof WC_Product ) {
			return is_array( $ids ) ? $ids : array();
		}
		$product_id = $product->get_id();
		if ( '' === $this->url_for( $product_id ) ) {
			return is_array( $ids ) ? $ids : array();
		}
		return array( $product_id );
	}

	/**
	 * Give the image real alt text, falling back to the product name.
	 *
	 * Alt normally lives in `_wp_attachment_image_alt` on the attachment, which synced products do
	 * not have, so without this every product image ships empty alt text.
	 *
	 * @param mixed  $value     Short-circuit value; null means "not handled".
	 * @param int    $object_id Post ID being read.
	 * @param string $meta_key  Meta key being read.
	 * @param bool   $single    Whether a single value was requested.
	 * @return mixed
	 */
	public function image_alt_meta( $value, $object_id, $meta_key, $single ) {
		if ( '_wp_attachment_image_alt' !== $meta_key || null !== $value ) {
			return $value;
		}
		if ( '' === $this->url_for( (int) $object_id ) ) {
			return $value;
		}
		$alt = get_the_title( (int) $object_id );

		return $single ? $alt : array( $alt );
	}

	/**
	 * Put the vendor URL into product schema markup, which otherwise reports no image.
	 *
	 * @param array $markup  Structured data.
	 * @param mixed $product Product object.
	 * @return array
	 */
	public function structured_data( $markup, $product ) {
		if ( ! is_array( $markup ) || ! $product instanceof WC_Product ) {
			return $markup;
		}
		if ( ! empty( $markup['image'] ) ) {
			return $markup;
		}
		$url = $this->url_for( $product->get_id() );
		if ( '' !== $url ) {
			$markup['image'] = esc_url_raw( $url );
		}
		return $markup;
	}

	/**
	 * Override Blocksy's ct_featured_media so live-search thumbnails use _external_thumbnail_url.
	 *
	 * Registered on blocksy:rest_api:live_search:fields so it replaces the theme's callback
	 * (same field name, later registration wins). Shape matches what search-implementation.js
	 * reads: media_details.sizes.thumbnail.source_url.
	 */
	public function register_live_search_media_field(): void {
		register_rest_field(
			'search-result',
			'ct_featured_media',
			array(
				'get_callback' => array( $this, 'live_search_featured_media' ),
			)
		);
	}

	/**
	 * @param array $post Search-result payload from WP_REST_Search_Controller.
	 * @return array|null
	 */
	public function live_search_featured_media( $post ) {
		if ( ! is_array( $post ) || empty( $post['id'] ) ) {
			return null;
		}
		$product_id = (int) $post['id'];
		$url        = self::thumbnail_url( $product_id );

		if ( '' === $url ) {
			$thumb_id = (int) get_post_meta( $product_id, '_thumbnail_id', true );
			if ( $thumb_id > 0 ) {
				$src = wp_get_attachment_image_src( $thumb_id, 'thumbnail' );
				if ( is_array( $src ) && ! empty( $src[0] ) && is_string( $src[0] ) ) {
					$url = $src[0];
				}
			}
		}

		if ( '' === $url ) {
			return null;
		}

		$safe = esc_url_raw( $url );
		return array(
			'id'            => $product_id,
			'source_url'    => $safe,
			'alt_text'      => get_the_title( $product_id ),
			'media_details' => array(
				'sizes' => array(
					'thumbnail' => array(
						'source_url' => $safe,
						'width'      => 150,
						'height'     => 150,
					),
				),
			),
		);
	}
}
