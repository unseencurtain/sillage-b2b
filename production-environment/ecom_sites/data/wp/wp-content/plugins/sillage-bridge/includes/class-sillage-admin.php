<?php
/**
 * Read-only status screen in wp-admin.
 *
 * @package Sillage_Bridge
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * A diagnostics page, deliberately with no settings on it.
 *
 * Configuration lives in the sillage-core dashboard so there is exactly one source of truth. What
 * this page is for is answering "is the bridge wired up correctly?" without leaving WordPress.
 */
final class Sillage_Admin {

	public function register(): void {
		add_action( 'admin_menu', array( $this, 'add_menu' ) );
	}

	public function add_menu(): void {
		add_submenu_page(
			'woocommerce',
			__( 'Sillage Sync', 'sillage-bridge' ),
			__( 'Sillage Sync', 'sillage-bridge' ),
			'manage_woocommerce',
			'sillage-bridge',
			array( $this, 'render' )
		);
	}

	public function render(): void {
		if ( ! current_user_can( 'manage_woocommerce' ) ) {
			wp_die( esc_html__( 'You do not have permission to view this page.', 'sillage-bridge' ) );
		}

		global $wpdb;

		$products = (int) $wpdb->get_var(
			"SELECT COUNT(*) FROM {$wpdb->posts} WHERE post_type = 'product' AND post_status = 'publish'"
		);
		$synced = (int) $wpdb->get_var(
			"SELECT COUNT(*) FROM {$wpdb->postmeta} WHERE meta_key = '_sillage_vendor'"
		);

		$attributes = array();
		if ( function_exists( 'wc_get_attribute_taxonomies' ) ) {
			foreach ( wc_get_attribute_taxonomies() as $attribute ) {
				$attributes[] = 'pa_' . $attribute->attribute_name;
			}
		}

		$checks = array(
			array(
				__( 'WooCommerce currency', 'sillage-bridge' ),
				(string) get_option( 'woocommerce_currency' ),
				'EUR' === get_option( 'woocommerce_currency' ),
				__( 'Both vendors quote EUR.', 'sillage-bridge' ),
			),
			array(
				__( 'High-Performance Order Storage', 'sillage-bridge' ),
				'yes' === get_option( 'woocommerce_custom_orders_table_enabled' ) ? __( 'enabled', 'sillage-bridge' ) : __( 'disabled', 'sillage-bridge' ),
				'yes' === get_option( 'woocommerce_custom_orders_table_enabled' ),
				__( 'Order dispatch reads the wp_wc_orders tables.', 'sillage-bridge' ),
			),
			array(
				__( 'WP-Cron', 'sillage-bridge' ),
				defined( 'DISABLE_WP_CRON' ) && DISABLE_WP_CRON ? __( 'disabled', 'sillage-bridge' ) : __( 'enabled', 'sillage-bridge' ),
				defined( 'DISABLE_WP_CRON' ) && DISABLE_WP_CRON,
				__( 'Scheduling belongs to the sillage-core container.', 'sillage-bridge' ),
			),
			array(
				__( 'EAN index readable', 'sillage-bridge' ),
				Sillage_Settings::ean_index_available() ? __( 'yes', 'sillage-bridge' ) : __( 'no', 'sillage-bridge' ),
				Sillage_Settings::ean_index_available(),
				__( 'Barcode search reads sillage.sil_ean_index.', 'sillage-bridge' ),
			),
			array(
				__( 'Shared secret configured', 'sillage-bridge' ),
				'' !== Sillage_Settings::shared_secret() ? __( 'yes', 'sillage-bridge' ) : __( 'no', 'sillage-bridge' ),
				'' !== Sillage_Settings::shared_secret(),
				__( 'Authenticates the sync engine to WordPress.', 'sillage-bridge' ),
			),
			array(
				__( 'Gender attribute', 'sillage-bridge' ),
				in_array( 'pa_gender', $attributes, true ) ? __( 'registered', 'sillage-bridge' ) : __( 'missing', 'sillage-bridge' ),
				in_array( 'pa_gender', $attributes, true ),
				__( 'Created on plugin activation.', 'sillage-bridge' ),
			),
			array(
				__( 'Product type attribute', 'sillage-bridge' ),
				in_array( 'pa_item-type', $attributes, true ) ? __( 'registered', 'sillage-bridge' ) : __( 'missing', 'sillage-bridge' ),
				in_array( 'pa_item-type', $attributes, true ),
				__( 'Slugged item-type because WordPress reserves "type".', 'sillage-bridge' ),
			),
		);

		$activation_errors = get_option( Sillage_Activator::ERRORS_OPTION, array() );

		?>
		<div class="wrap">
			<h1><?php esc_html_e( 'Sillage Sync', 'sillage-bridge' ); ?></h1>

			<?php if ( is_array( $activation_errors ) && ! empty( $activation_errors ) ) : ?>
				<div class="notice notice-error">
					<p><strong><?php esc_html_e( 'Some product attributes could not be created:', 'sillage-bridge' ); ?></strong></p>
					<ul style="list-style:disc;margin-left:2em">
					<?php foreach ( $activation_errors as $slug => $message ) : ?>
						<li><code><?php echo esc_html( (string) $slug ); ?></code> — <?php echo esc_html( (string) $message ); ?></li>
					<?php endforeach; ?>
					</ul>
					<p><?php esc_html_e( 'Deactivate and reactivate the plugin after resolving the cause.', 'sillage-bridge' ); ?></p>
				</div>
			<?php endif; ?>

			<p>
				<?php esc_html_e( 'This plugin is a thin bridge. Products, pricing, vendors and order dispatch are all configured in the Sillage dashboard.', 'sillage-bridge' ); ?>
				<a href="<?php echo esc_url( Sillage_Settings::dashboard_url() ); ?>" target="_blank" rel="noopener" class="button button-primary">
					<?php esc_html_e( 'Open the Sillage dashboard', 'sillage-bridge' ); ?>
				</a>
			</p>

			<h2 class="title"><?php esc_html_e( 'Catalogue', 'sillage-bridge' ); ?></h2>
			<table class="widefat striped" style="max-width:640px">
				<tbody>
					<tr>
						<td><?php esc_html_e( 'Published products', 'sillage-bridge' ); ?></td>
						<td><strong><?php echo esc_html( number_format_i18n( $products ) ); ?></strong></td>
					</tr>
					<tr>
						<td><?php esc_html_e( 'Managed by Sillage', 'sillage-bridge' ); ?></td>
						<td><strong><?php echo esc_html( number_format_i18n( $synced ) ); ?></strong></td>
					</tr>
				</tbody>
			</table>

			<h2 class="title"><?php esc_html_e( 'Configuration checks', 'sillage-bridge' ); ?></h2>
			<table class="widefat striped">
				<thead>
					<tr>
						<th style="width:220px"><?php esc_html_e( 'Check', 'sillage-bridge' ); ?></th>
						<th style="width:120px"><?php esc_html_e( 'Value', 'sillage-bridge' ); ?></th>
						<th><?php esc_html_e( 'Why it matters', 'sillage-bridge' ); ?></th>
					</tr>
				</thead>
				<tbody>
				<?php foreach ( $checks as $check ) : ?>
					<tr>
						<td><?php echo esc_html( $check[0] ); ?></td>
						<td>
							<span style="color:<?php echo $check[2] ? '#008a20' : '#b32d2e'; ?>;font-weight:600">
								<?php echo esc_html( $check[1] ); ?>
							</span>
						</td>
						<td><?php echo esc_html( $check[3] ); ?></td>
					</tr>
				<?php endforeach; ?>
				</tbody>
			</table>

			<p class="description" style="margin-top:1em">
				<?php esc_html_e( 'Product images are served directly from each vendor. Nothing is downloaded into the media library, which is why synced products have no featured image set.', 'sillage-bridge' ); ?>
			</p>
		</div>
		<?php
	}
}
